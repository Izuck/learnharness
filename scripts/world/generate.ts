/**
 * One-time world generation: for each degree, ask Claude (Opus, one call at a
 * time) for the course list, then for each course its topics. Every course's
 * batch is written to <build>/<degree>/<course-slug>.json as it lands, so a
 * rerun RESUMES (finished courses are not asked again). Finally every batch on
 * disk is merged into data/world/topics.json (positions empty — layout.ts
 * places them) through the Cartographer store, plus a WORLD.md report. When
 * the dedupe step has saved build/merges.json (npm run world:dedupe), its
 * verdicts are applied in that merge too.
 *
 *   npm run world:generate            all degrees
 *   npm run world:generate -- math    only the named degree ids
 *
 * Writes under LH_DATA_DIR like the app; `npm run world:generate` preloads
 * scripts/default-data-dir.mjs, so an unset LH_DATA_DIR means the app's own
 * data folder (never the repo's data/). The resolved folder is printed first.
 * Importing this module has no side effects; the run starts only when it is
 * the entry point.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PATHS, WORLD_FILES } from "../../config.ts";
import type { CourseTopicsBatch, WorldDegree } from "../../src/core/contracts/world.ts";
import { isCourseTopicsBatch, topicSlug } from "../../src/core/world.ts";
import { WORLD_DEGREES } from "../../src/core/world-layout.ts";
import { worldStore } from "../../src/store/world.ts";
import { buildWorld, readJson } from "./build-world.ts";
import { runClaudeJson } from "./claude-cli.ts";

const PROMPTS = path.join(path.dirname(fileURLToPath(import.meta.url)), "prompts");

const COURSES_SCHEMA = {
	type: "object",
	properties: { courses: { type: "array", items: { type: "string" } } },
	required: ["courses"],
};

const TOPICS_SCHEMA = {
	type: "object",
	properties: {
		degree: { type: "string" },
		course: { type: "string" },
		topics: {
			type: "array",
			items: {
				type: "object",
				properties: {
					name: { type: "string" },
					scope: { type: "string" },
					prereqs: { type: "array", items: { type: "string" } },
				},
				required: ["name", "scope", "prereqs"],
			},
		},
	},
	required: ["degree", "course", "topics"],
};

const COURSES_CACHE = "_courses.json";

/** Stop the run after this many asks in a row fail (a course list or a
 *  course's topics, retried and still bad or thrown) - most likely the plan
 *  limit; a rerun resumes. */
const MAX_CONSECUTIVE_FAILURES = 3;

/** A usable batch: right shape AND at least one topic (an empty list would be
 *  cached as "done" and the course skipped forever). */
const isUsableBatch = (v: unknown): v is CourseTopicsBatch => isCourseTopicsBatch(v) && v.topics.length > 0;

/** A usable course list: at least one non-blank name (an empty list would be
 *  cached and the degree skipped forever, so a cached empty list reads as absent). */
const isCoursesReply = (v: unknown): v is { courses: string[] } =>
	typeof v === "object" &&
	v !== null &&
	Array.isArray((v as { courses?: unknown }).courses) &&
	(v as { courses: unknown[] }).courses.length > 0 &&
	(v as { courses: unknown[] }).courses.every((c) => typeof c === "string" && c.trim() !== "");

/** Ask up to twice; the first failure (thrown or wrong shape) is retried once. */
async function askValid<T>(
	what: string,
	tryOnce: () => Promise<T | null>,
	log: (s: string) => void,
): Promise<T | null> {
	for (let attempt = 1; attempt <= 2; attempt++) {
		try {
			const out = await tryOnce();
			if (out !== null) return out;
			log(`  ${what}: reply had the wrong shape (attempt ${attempt}/2)`);
		} catch (e) {
			log(`  ${what}: ${e instanceof Error ? e.message : String(e)} (attempt ${attempt}/2)`);
		}
	}
	return null;
}

export async function generateWorld(o: {
	degrees: WorldDegree[];
	buildDir: string;
	ask: typeof runClaudeJson;
	log: (s: string) => void;
}): Promise<CourseTopicsBatch[]> {
	const { buildDir, ask, log } = o;
	const coursesPrompt = fs.readFileSync(path.join(PROMPTS, "courses.md"), "utf-8");
	const topicsPrompt = fs.readFileSync(path.join(PROMPTS, "topics.md"), "utf-8");
	const batches: CourseTopicsBatch[] = [];
	let failures = 0;
	/** Record a failed ask; true when the run must stop. */
	const failed = (): boolean => {
		failures++;
		if (failures < MAX_CONSECUTIVE_FAILURES) return false;
		log(
			`Stopped early after ${failures} failed requests in a row (plan limit?). ` +
				"Batches already written are kept; rerun to resume.",
		);
		return true;
	};

	for (const degree of o.degrees) {
		const dir = path.join(buildDir, degree.id);
		fs.mkdirSync(dir, { recursive: true });

		// The course list is cached so a resume keeps the same courses even
		// though the model's answer is not deterministic.
		const cachePath = path.join(dir, COURSES_CACHE);
		let courses: string[] | null = null;
		const cached = readJson(cachePath);
		if (isCoursesReply(cached)) courses = cached.courses;
		if (!courses) {
			log(`${degree.name}: listing courses`);
			const reply = await askValid(
				`${degree.name} courses`,
				async () => {
					const r = await ask<unknown>({
						model: "opus",
						systemPrompt: coursesPrompt,
						prompt: `List the courses of the ${degree.name} degree (id: ${degree.id}).`,
						schema: COURSES_SCHEMA,
					});
					return isCoursesReply(r) ? r : null;
				},
				log,
			);
			if (!reply) {
				log(`${degree.name}: skipped (no usable course list)`);
				if (failed()) return batches;
				continue;
			}
			failures = 0;
			courses = [...new Set(reply.courses.map((c) => c.trim()))];
			fs.writeFileSync(cachePath, JSON.stringify({ courses }), "utf-8");
		}

		for (const course of courses) {
			const file = path.join(dir, `${topicSlug(course) || "course"}.json`);
			const existing = readJson(file);
			if (isUsableBatch(existing)) {
				log(`${degree.name} / ${course}: already done`);
				batches.push(existing);
				continue;
			}
			log(`${degree.name} / ${course}: generating topics`);
			const batch = await askValid(
				`${degree.name} / ${course}`,
				async () => {
					const r = await ask<unknown>({
						model: "opus",
						systemPrompt: topicsPrompt,
						prompt: `Degree: ${degree.id} (${degree.name})\nCourse: ${course}\n`,
						schema: TOPICS_SCHEMA,
					});
					return isUsableBatch(r) ? r : null;
				},
				log,
			);
			if (!batch) {
				log(`${degree.name} / ${course}: skipped`);
				if (failed()) return batches;
				continue;
			}
			failures = 0;
			// Pin the identity the merge keys on, whatever the model echoed.
			const done: CourseTopicsBatch = { ...batch, degree: degree.id, course };
			fs.writeFileSync(file, JSON.stringify(done, null, "\t"), "utf-8");
			batches.push(done);
		}
	}
	return batches;
}

async function main(): Promise<void> {
	console.log(`Data folder: ${PATHS.data}`);
	const wanted = process.argv.slice(2);
	const degrees = wanted.length ? WORLD_DEGREES.filter((d) => wanted.includes(d.id)) : [...WORLD_DEGREES];
	if (degrees.length === 0) throw new Error(`No known degree in: ${wanted.join(", ")}`);
	const log = (s: string): void => console.log(s);

	await generateWorld({ degrees, buildDir: WORLD_FILES.build, ask: runClaudeJson, log });

	// The world is every batch on disk (with build/merges.json applied when the
	// dedupe step has run), so a partial run still yields a consistent topics.json.
	const plan = buildWorld({
		buildDir: WORLD_FILES.build,
		mergesFile: WORLD_FILES.merges,
		reportFile: WORLD_FILES.report,
		store: worldStore,
	});
	log(`Wrote ${plan.topics.length} topics to ${WORLD_FILES.topics} and ${WORLD_FILES.report}`);
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(path.resolve(entry)).href) {
	main().catch((e) => {
		console.error(e);
		process.exitCode = 1;
	});
}
