/**
 * World dedupe: fold topics that name the same concept slightly differently
 * ("Bipolar Junction Transistor" / "Bipolar Junction Transistors", "Searching
 * and Sorting Algorithms" / "Algorithms: Searching and Sorting") into one, so
 * the cross-degree connection points are real. Run it after world:generate and
 * before world:layout.
 *
 *   npm run world:dedupe                  find, ask, save, rebuild
 *   npm run world:dedupe -- --dry-run     ask, print the decisions, write nothing
 *   npm run world:dedupe -- --no-ask      apply saved decisions only, no model calls
 *   npm run world:dedupe -- --force       merge even topics that already have a layout position
 *
 * Candidate groups come from core/world.ts dedupeCandidates (exact normalised
 * names, plus fuzzy pairs that share no course). Sonnet judges about 40 groups
 * per call, one call at a time. Every judged group is stored in
 * <data>/world/build/merges.json (keyed by its member ids, so a rerun never
 * re-asks); that file is saved after every call, atomically, so an interrupted
 * run keeps its progress. A group the model skipped or answered badly stays
 * undecided for the next run. The per-course batches on disk are never edited:
 * merges are applied when topics.json is built, here and by world:generate.
 *
 * Then topics.json and WORLD.md are rebuilt (build-world.ts, shared with
 * generate.ts: positions and anchors carried), placements.jsonl gets NEW lines
 * moving nodes off merged-away topics onto their canonical one (the ledger is
 * append-only and never rewritten), and build/merges.md lists every merge and
 * every "kept separate" with its reason.
 *
 * Safety: if a topic that would be merged away already has a layout position,
 * it refuses unless --force is passed. Batches that appear while this runs
 * (world:generate is writing them) are read afresh for the final rebuild and
 * are asked about on the next run.
 *
 * Reads and writes under LH_DATA_DIR like the app; `npm run world:dedupe`
 * preloads scripts/default-data-dir.mjs, so an unset LH_DATA_DIR means the
 * app's own data folder. The resolved folder is printed first. Importing this
 * module has no side effects; the run starts only when it is the entry point.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PATHS, WORLD_FILES } from "../../config.ts";
import type { CourseTopicsBatch, TopicMerges, WorldDegree, WorldTopic } from "../../src/core/contracts/world.ts";
import type { WorldStore } from "../../src/core/ports.ts";
import {
	activeMerges,
	canonicalNameMap,
	decisionKey,
	dedupeCandidates,
	mergeDegreeTopics,
	mergePlacements,
	repointPlacements,
	topicSlug,
} from "../../src/core/world.ts";
import { worldStore } from "../../src/store/world.ts";
import {
	buildWorld,
	planWorld,
	rawTopicIds,
	readAllBatches,
	readMerges,
	writeMerges,
} from "./build-world.ts";
import { runClaudeJson } from "./claude-cli.ts";

const PROMPTS = path.join(path.dirname(fileURLToPath(import.meta.url)), "prompts");

/** Groups judged per model call. */
const BATCH_SIZE = 40;

/** Stop asking after this many calls in a row fail (each already retried once) -
 *  most likely the plan limit; a rerun resumes. */
const MAX_CONSECUTIVE_FAILURES = 3;

/** Merging can expose new candidates (a merged topic now sits near another), so
 *  a run loops over the NEW groups; this bounds it. */
const MAX_PASSES = 5;

const DECISIONS_SCHEMA = {
	type: "object",
	properties: {
		decisions: {
			type: "array",
			items: {
				type: "object",
				properties: {
					group: { type: "integer" },
					same: { type: "boolean" },
					members: { type: "array", items: { type: "integer" } },
					canonical: { type: "string" },
					reason: { type: "string" },
				},
				required: ["group", "same", "members", "canonical", "reason"],
			},
		},
	},
	required: ["decisions"],
};

export interface DedupeOptions {
	buildDir: string;
	/** build/merges.json */
	mergesFile: string;
	/** WORLD.md */
	reportFile: string;
	store: WorldStore;
	ask: typeof runClaudeJson;
	log: (s: string) => void;
	/** Ask the model, print the decisions, write nothing. */
	dryRun?: boolean;
	/** Apply saved decisions and rebuild; no model calls. */
	noAsk?: boolean;
	/** Merge topics that already have a layout position. */
	force?: boolean;
	/** Groups per model call (default 40). */
	batchSize?: number;
	now?: () => string;
	degrees?: readonly WorldDegree[];
}

export interface DedupeSummary {
	/** Candidate groups found at the start of the run (decided or not). */
	candidates: number;
	/** Groups decided by this run. */
	newlyDecided: number;
	/** Of those, judged the same concept. */
	merged: number;
	/** Of those, judged different. */
	keptSeparate: number;
	/** Candidate groups still undecided at the end. */
	undecided: number;
	/** Topics with no merges applied, and after. */
	topicsBefore: number;
	topicsAfter: number;
	/** Topics taught by two or more degrees, with no merges applied, and after. */
	sharedBefore: number;
	sharedAfter: number;
	/** New placement lines appended. */
	repointed: number;
}

interface Verdict {
	/** The topic ids the verdict is about: the whole group, or - when the model
	 *  found only some members to be the same concept - that subset. */
	ids: string[];
	same: boolean;
	canonical?: string;
	reason: string;
}

const shared = (topics: readonly WorldTopic[]): number => topics.filter((t) => t.degrees.length >= 2).length;

const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}...`);

/** The user prompt for one call: each group numbered from 1, its members with
 *  scope, degrees and a few courses. */
export function buildDedupePrompt(groups: readonly string[][], byId: ReadonlyMap<string, WorldTopic>): string {
	const out: string[] = [];
	groups.forEach((ids, i) => {
		out.push(`Group ${i + 1}`);
		for (const [n, id] of ids.entries()) {
			const t = byId.get(id);
			if (!t) {
				out.push(`- (${n + 1}) "${id}"`);
				continue;
			}
			const courses = t.courses.slice(0, 5).join("; ");
			out.push(
				`- (${n + 1}) "${t.name}" | scope: ${clip(t.scope, 240) || "(none)"} | degrees: ${t.degrees.join(", ")} | courses: ${courses || "(none)"}`,
			);
		}
		out.push("");
	});
	return `${out.join("\n")}`;
}

/** Validate a model reply against the chunk it answered: one verdict per group
 *  index. same:true needs a canonical name that slugs to something and is not
 *  another existing topic; `members` (1-based numbers within the group) may name
 *  a subset of two or more members, so a mixed group still folds its true
 *  duplicates (the rest regroup with the merged topic on the next pass).
 *  Anything else is left out (undecided). */
function validateReply(
	reply: unknown,
	chunk: readonly string[][],
	existingIds: ReadonlySet<string>,
	log: (s: string) => void,
): Map<number, Verdict> {
	const out = new Map<number, Verdict>();
	const list = (reply as { decisions?: unknown } | null)?.decisions;
	if (!Array.isArray(list)) return out;
	for (const raw of list) {
		if (typeof raw !== "object" || raw === null) continue;
		const d = raw as Record<string, unknown>;
		const idx = typeof d.group === "number" && Number.isInteger(d.group) ? d.group - 1 : -1;
		const members = chunk[idx];
		if (!members || out.has(idx) || typeof d.same !== "boolean") continue;
		const reason = typeof d.reason === "string" ? d.reason.trim().replace(/\s+/g, " ") : "";
		if (!d.same) {
			out.set(idx, { ids: [...members], same: false, reason });
			continue;
		}
		let ids = [...members];
		if (Array.isArray(d.members) && d.members.length > 0) {
			const picked = new Set<string>();
			for (const n of d.members) if (typeof n === "number" && members[n - 1] !== undefined) picked.add(members[n - 1] as string);
			if (picked.size < 2) {
				log(`  group ${idx + 1}: members ${JSON.stringify(d.members)} name fewer than two topics; left undecided`);
				continue;
			}
			ids = [...picked].sort();
		}
		const canonical = typeof d.canonical === "string" ? d.canonical.trim() : "";
		const id = topicSlug(canonical);
		if (!id) {
			log(`  group ${idx + 1}: same:true without a usable canonical name; left undecided`);
			continue;
		}
		if (existingIds.has(id) && !ids.includes(id)) {
			log(`  group ${idx + 1}: canonical "${canonical}" is a different existing topic; left undecided`);
			continue;
		}
		out.set(idx, { ids, same: true, canonical, reason });
	}
	return out;
}

/** Ask up to twice; the first failure (thrown or no usable reply) is retried once. */
async function askTwice(
	call: () => Promise<unknown>,
	log: (s: string) => void,
): Promise<unknown | null> {
	for (let attempt = 1; attempt <= 2; attempt++) {
		try {
			const r = await call();
			if (r && typeof r === "object" && Array.isArray((r as { decisions?: unknown }).decisions)) return r;
			log(`  reply had the wrong shape (attempt ${attempt}/2)`);
		} catch (e) {
			log(`  ${e instanceof Error ? e.message : String(e)} (attempt ${attempt}/2)`);
		}
	}
	return null;
}

function chunks<T>(xs: readonly T[], n: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
	return out;
}

/** build/merges.md: every merge (canonical <- aliases, with degrees) and every
 *  group kept separate, each with its reason. */
export function renderMergesReport(
	merges: TopicMerges,
	rawTopics: readonly WorldTopic[],
	finalTopics: readonly WorldTopic[],
): string {
	const raw = new Map(rawTopics.map((t) => [t.id, t]));
	const fin = new Map(finalTopics.map((t) => [t.id, t]));
	const rawIds = new Set(raw.keys());
	const names = canonicalNameMap(merges, rawIds);
	const label = (id: string): string => {
		const t = raw.get(id) ?? fin.get(id);
		const name = t?.name ?? names.get(id) ?? id;
		const degrees = t ? ` (${t.degrees.join(", ")})` : "";
		return `${name}${degrees}`;
	};
	const active = activeMerges(merges, rawIds);
	const activeKeys = new Set(active.map((m) => m.key));
	const separate = Object.entries(merges.decisions)
		.filter(([, d]) => !d.same)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

	const lines: string[] = ["# Topic merges", ""];
	lines.push(`${active.length} merged groups, ${separate.length} kept separate. Written by world:dedupe.`, "");
	lines.push(`## Merged (${active.length})`, "");
	for (const m of [...active].sort((a, b) => (a.canonicalName < b.canonicalName ? -1 : a.canonicalName > b.canonicalName ? 1 : 0))) {
		const target = fin.get(m.canonicalId);
		const degrees = target ? ` (${target.degrees.join(", ")})` : "";
		lines.push(`- **${m.canonicalName}**${degrees} <- ${m.members.filter((id) => id !== m.canonicalId).map(label).join("; ")}`);
		if (m.reason) lines.push(`  - ${m.reason}`);
	}
	lines.push("", `## Kept separate (${separate.length})`, "");
	for (const [key, d] of separate) {
		lines.push(`- ${key.split("|").map(label).join(" | ")}`);
		if (d.reason) lines.push(`  - ${d.reason}`);
	}
	const stale = Object.entries(merges.decisions).filter(([k, d]) => d.same && !activeKeys.has(k));
	if (stale.length > 0) {
		lines.push("", `## Not applied (${stale.length})`, "", "Decisions whose topics no longer exist (or without a usable canonical name).", "");
		for (const [key] of stale.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) lines.push(`- ${key}`);
	}
	return `${lines.join("\n")}\n`;
}

export async function dedupeWorld(o: DedupeOptions): Promise<DedupeSummary> {
	const { log, store } = o;
	const now = o.now ?? (() => new Date().toISOString());
	const batchSize = Math.max(1, o.batchSize ?? BATCH_SIZE);
	const reportMd = path.join(o.buildDir, "merges.md");

	let merges = readMerges(o.mergesFile);
	const batches: CourseTopicsBatch[] = readAllBatches(o.buildDir);
	const rawIds = rawTopicIds(batches);
	const rawTopics = mergeDegreeTopics(batches).topics;

	const view = (m: TopicMerges) => planWorld({ batches, merges: m, prev: null, degrees: o.degrees });

	/** Refuse (or, when forced or a dry run, warn) if applying `m` would merge
	 *  away a topic that already has a layout position. */
	const guardPositions = (m: TopicMerges): void => {
		const prev = store.readWorld();
		if (!prev) return;
		const positioned = new Set(prev.topics.filter((t) => t.position).map((t) => t.id));
		const hit = [...view(m).aliases.keys()].filter((id) => positioned.has(id)).sort();
		if (hit.length === 0) return;
		const eg = hit.slice(0, 5).join(", ");
		if (o.force || o.dryRun) {
			log(`${o.force ? "--force:" : "Warning (dry run):"} ${hit.length} topic(s) to merge away already have a layout position (${eg}); their positions would be dropped.`);
			return;
		}
		throw new Error(
			`Refusing: ${hit.length} topic(s) that would be merged away already have a layout position (e.g. ${eg}). ` +
				"Merging them would change the saved layout. Run dedupe before world:layout, or pass --force to merge anyway " +
				"(the canonical topic keeps its own position; merged-away positions are dropped).",
		);
	};

	guardPositions(merges);

	let current = view(merges);
	const initial = dedupeCandidates(current.topics);
	const candidates = initial.length;
	const startedWith = new Set(Object.keys(merges.decisions));

	let mergedNow = 0;
	let keptNow = 0;
	const newVerdicts: Array<{ key: string; verdict: Verdict; names: string[] }> = [];

	if (!o.noAsk) {
		const prompt = fs.readFileSync(path.join(PROMPTS, "dedupe.md"), "utf-8");
		const asked = new Set<string>();
		let failures = 0;
		let stop = false;
		for (let pass = 0; pass < MAX_PASSES && !stop; pass++) {
			const todo = dedupeCandidates(current.topics).filter((g) => {
				const key = decisionKey(g);
				return !(key in merges.decisions) && !asked.has(key);
			});
			if (todo.length === 0) break;
			const byId = new Map(current.topics.map((t) => [t.id, t]));
			const existingIds = new Set([...rawIds, ...byId.keys()]);
			let progressed = false;
			const calls = chunks(todo, batchSize);
			for (const [n, chunk] of calls.entries()) {
				for (const g of chunk) asked.add(decisionKey(g));
				log(`Asking about ${chunk.length} groups (call ${n + 1}/${calls.length}${pass > 0 ? `, pass ${pass + 1}` : ""})`);
				const reply = await askTwice(
					() =>
						o.ask<unknown>({
							model: "sonnet",
							systemPrompt: prompt,
							prompt: buildDedupePrompt(chunk, byId),
							schema: DECISIONS_SCHEMA,
						}),
					log,
				);
				if (!reply) {
					failures++;
					if (failures >= MAX_CONSECUTIVE_FAILURES) {
						log(`Stopped early after ${failures} failed requests in a row (plan limit?). Decisions so far are kept; rerun to resume.`);
						stop = true;
						break;
					}
					continue;
				}
				failures = 0;
				const verdicts = validateReply(reply, chunk, existingIds, log);
				const skipped = chunk.length - verdicts.size;
				if (skipped > 0) log(`  ${skipped} group(s) not decided (left for the next run)`);
				if (verdicts.size === 0) continue;

				const decidedAt = now();
				const decisions = { ...merges.decisions };
				for (const [idx, v] of verdicts) {
					const ids = v.ids;
					const key = decisionKey(ids);
					decisions[key] = { same: v.same, ...(v.same ? { canonical: v.canonical } : {}), reason: v.reason, decidedAt };
					newVerdicts.push({ key, verdict: v, names: ids.map((id) => byId.get(id)?.name ?? id) });
					if (v.same) mergedNow++;
					else keptNow++;
				}
				const next: TopicMerges = { version: 1, decisions };
				guardPositions(next);
				merges = next;
				if (!o.dryRun) writeMerges(o.mergesFile, merges);
				progressed = true;
			}
			if (!progressed) break;
			current = view(merges);
		}
	}

	// Rebuild. Batches that landed while we were asking are read afresh here;
	// their new groups are asked about on the next run.
	const finalPlan = o.dryRun
		? planWorld({ batches, merges, prev: store.readWorld(), degrees: o.degrees })
		: buildWorld({
				buildDir: o.buildDir,
				mergesFile: o.mergesFile,
				reportFile: o.reportFile,
				store,
				degrees: o.degrees,
				now,
			});

	// Placements: append new lines for nodes whose latest placement is merged away.
	const lines = store.readPlacements();
	const latest = mergePlacements(lines, new Set(lines.map((l) => l.nodeId)));
	const repoints = repointPlacements(latest, finalPlan.aliases, now());
	if (!o.dryRun) for (const p of repoints) store.appendPlacement(p);

	const finalRaw = o.dryRun ? rawTopics : mergeDegreeTopics(finalPlan.batches).topics;
	if (!o.dryRun) fs.writeFileSync(reportMd, renderMergesReport(readMerges(o.mergesFile), finalRaw, finalPlan.topics), "utf-8");

	const stillUndecided = dedupeCandidates(finalPlan.topics).filter((g) => !(decisionKey(g) in merges.decisions)).length;
	const summary: DedupeSummary = {
		candidates,
		newlyDecided: newVerdicts.length,
		merged: mergedNow,
		keptSeparate: keptNow,
		undecided: stillUndecided,
		topicsBefore: finalRaw.length,
		topicsAfter: finalPlan.topics.length,
		sharedBefore: shared(finalRaw),
		sharedAfter: shared(finalPlan.topics),
		repointed: repoints.length,
	};

	if (o.dryRun) {
		for (const nv of newVerdicts) {
			const names = nv.names.map((n) => `"${n}"`).join(" | ");
			log(nv.verdict.same ? `MERGE  "${nv.verdict.canonical}" <- ${names}: ${nv.verdict.reason}` : `KEEP   ${names}: ${nv.verdict.reason}`);
		}
	}
	log("");
	log(`Candidate groups:   ${summary.candidates} (${startedWith.size} already decided before this run)`);
	log(`Newly decided:      ${summary.newlyDecided} (${summary.merged} merged, ${summary.keptSeparate} kept separate)`);
	log(`Still undecided:    ${summary.undecided}`);
	log(`Topics:             ${summary.topicsBefore} -> ${summary.topicsAfter}`);
	log(`Shared by 2+ degrees: ${summary.sharedBefore} -> ${summary.sharedAfter}`);
	log(`Placements ${o.dryRun ? "that would be " : ""}repointed: ${summary.repointed}`);
	if (o.dryRun) log("Dry run: nothing written.");
	else log(`Wrote ${o.mergesFile}, ${reportMd}, ${o.reportFile} and the world file.`);
	return summary;
}

function parseFlags(argv: string[]): { dryRun: boolean; noAsk: boolean; force: boolean } {
	const known = new Set(["--dry-run", "--no-ask", "--force"]);
	for (const a of argv) if (!known.has(a)) throw new Error(`Unknown argument: ${a} (known: ${[...known].join(", ")})`);
	return { dryRun: argv.includes("--dry-run"), noAsk: argv.includes("--no-ask"), force: argv.includes("--force") };
}

async function main(): Promise<void> {
	const flags = parseFlags(process.argv.slice(2));
	console.log(`Data folder: ${PATHS.data}`);
	await dedupeWorld({
		buildDir: WORLD_FILES.build,
		mergesFile: WORLD_FILES.merges,
		reportFile: WORLD_FILES.report,
		store: worldStore,
		ask: runClaudeJson,
		log: (s) => console.log(s),
		...flags,
	});
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(path.resolve(entry)).href) {
	main().catch((e) => {
		console.error(e instanceof Error ? e.message : e);
		process.exitCode = 1;
	});
}
