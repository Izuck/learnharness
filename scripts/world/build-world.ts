/**
 * The shared tail of the world scripts: read every per-course batch under
 * build/, apply build/merges.json (the dedupe verdicts) if present, carry the
 * previous world's positions and anchors, write topics.json through the
 * Cartographer store, and rewrite WORLD.md. Both generate.ts and dedupe.ts end
 * here so they can never drift apart.
 *
 * No side effects at import; every path and the store are passed in.
 */

import fs from "node:fs";
import path from "node:path";
import type { CourseTopicsBatch, TopicMerges, WorldDegree, WorldFile, WorldTopic } from "../../src/core/contracts/world.ts";
import type { WorldStore } from "../../src/core/ports.ts";
import {
	aliasMap,
	canonicalNameMap,
	carryPositions,
	isCourseTopicsBatch,
	isTopicMerges,
	mergeDegreeTopics,
	topicSlug,
} from "../../src/core/world.ts";
import { WORLD_DEGREES } from "../../src/core/world-layout.ts";

export const readJson = (file: string): unknown => {
	try {
		return JSON.parse(fs.readFileSync(file, "utf-8"));
	} catch {
		return null;
	}
};

/** Every valid batch on disk under buildDir, in a stable order. A batch that
 *  is mid-write (invalid JSON) is skipped and picked up by the next run. */
export function readAllBatches(buildDir: string): CourseTopicsBatch[] {
	const out: CourseTopicsBatch[] = [];
	if (!fs.existsSync(buildDir)) return out;
	for (const d of fs.readdirSync(buildDir).sort()) {
		const dir = path.join(buildDir, d);
		if (!fs.statSync(dir).isDirectory()) continue;
		for (const f of fs.readdirSync(dir).sort()) {
			if (f.startsWith("_") || !f.endsWith(".json")) continue;
			const v = readJson(path.join(dir, f));
			if (isCourseTopicsBatch(v)) out.push(v);
		}
	}
	return out;
}

/** The dedupe verdicts at `file`. Only a missing file is empty. A file that is
 *  present but unreadable, unparseable or the wrong shape is a hard error:
 *  treating it as empty would re-ask every group, overwrite the verdicts, and
 *  let world:generate resurrect merged topics. */
export function readMerges(file: string): TopicMerges {
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf-8");
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, decisions: {} };
		throw new Error(`Cannot read ${file}: ${e instanceof Error ? e.message : String(e)}`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (e) {
		throw new Error(
			`${file} is not valid JSON (${e instanceof Error ? e.message : String(e)}). ` +
				"Fix or delete it (deleting forgets every dedupe decision); nothing was changed.",
		);
	}
	if (!isTopicMerges(parsed)) {
		throw new Error(
			`${file} is not a valid merge list (expected { version: 1, decisions: {...} }). ` +
				"Fix or delete it (deleting forgets every dedupe decision); nothing was changed.",
		);
	}
	return parsed;
}

/** Save the verdicts atomically (temp file, then rename), so an interrupted
 *  run keeps its progress and never leaves a half-written file. */
export function writeMerges(file: string, merges: TopicMerges): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.tmp-${process.pid}`;
	fs.writeFileSync(tmp, `${JSON.stringify(merges, null, "\t")}\n`, "utf-8");
	fs.renameSync(tmp, file);
}

/** The ids every batch topic name slugs to, before any merge. */
export function rawTopicIds(batches: readonly CourseTopicsBatch[]): Set<string> {
	const ids = new Set<string>();
	for (const b of batches) {
		for (const t of b.topics) {
			const id = topicSlug(t.name);
			if (id) ids.add(id);
		}
	}
	return ids;
}

export function renderReport(
	degrees: WorldDegree[],
	batches: CourseTopicsBatch[],
	topicCount: number,
	unresolved: Array<{ topic: string; prereq: string }>,
): string {
	const lines: string[] = [
		"# World",
		"",
		`${degrees.length} degrees, ${topicCount} topics (merged across degrees), ${batches.length} courses.`,
		"",
	];
	for (const d of degrees) {
		const mine = batches.filter((b) => b.degree === d.id);
		const total = mine.reduce((n, b) => n + b.topics.length, 0);
		lines.push(`## ${d.name} (${d.id}) - ${mine.length} courses, ${total} topics`, "");
		for (const b of mine) lines.push(`- ${b.course}: ${b.topics.length}`);
		lines.push("");
	}
	lines.push(`## Unresolved prereqs (${unresolved.length})`, "");
	lines.push("Prereq names that matched no generated topic; dropped from the world.", "");
	for (const u of unresolved) lines.push(`- ${u.topic}: "${u.prereq}"`);
	return `${lines.join("\n")}\n`;
}

export interface WorldPlan {
	batches: CourseTopicsBatch[];
	/** Merged topics with the previous world's positions carried. */
	topics: WorldTopic[];
	unresolvedPrereqs: Array<{ topic: string; prereq: string }>;
	/** Degrees with at least one batch. */
	present: WorldDegree[];
	/** Merged-away topic id -> canonical id. */
	aliases: Map<string, string>;
	prev: WorldFile | null;
}

/** Compute the world from batches and verdicts, touching nothing on disk. */
export function planWorld(o: {
	batches: CourseTopicsBatch[];
	merges: TopicMerges;
	prev: WorldFile | null;
	degrees?: readonly WorldDegree[];
}): WorldPlan {
	const rawIds = rawTopicIds(o.batches);
	const aliases = aliasMap(o.merges, rawIds);
	const names = canonicalNameMap(o.merges, rawIds);
	const merged = mergeDegreeTopics(o.batches, aliases, names);
	// A rerun must not wipe positions a previous layout saved.
	const topics = carryPositions(merged.topics, o.prev);
	const present = (o.degrees ?? WORLD_DEGREES).filter((d) => o.batches.some((b) => b.degree === d.id));
	return {
		batches: o.batches,
		topics,
		unresolvedPrereqs: merged.unresolvedPrereqs,
		present: [...present],
		aliases,
		prev: o.prev,
	};
}

/** Read every batch and mergesFile, build the world, write topics.json and
 *  WORLD.md. The world is every batch on disk, so a partial run still yields a
 *  consistent topics.json of what exists so far. */
export function buildWorld(o: {
	buildDir: string;
	mergesFile: string;
	reportFile: string;
	store: WorldStore;
	degrees?: readonly WorldDegree[];
	now?: () => string;
}): WorldPlan {
	const plan = planWorld({
		batches: readAllBatches(o.buildDir),
		merges: readMerges(o.mergesFile),
		prev: o.store.readWorld(),
		degrees: o.degrees,
	});
	o.store.writeWorld({
		version: 1,
		generatedAt: (o.now ?? (() => new Date().toISOString()))(),
		degrees: plan.present,
		topics: plan.topics,
		// Stored anchors go with the saved positions: dropping them would let the
		// next layout re-derive anchors the pinned topics no longer match.
		...(plan.prev?.anchors ? { anchors: plan.prev.anchors } : {}),
	});
	fs.mkdirSync(path.dirname(o.reportFile), { recursive: true });
	fs.writeFileSync(
		o.reportFile,
		renderReport(plan.present, plan.batches, plan.topics.length, plan.unresolvedPrereqs),
		"utf-8",
	);
	return plan;
}
