/**
 * World logic — pure functions over the world contracts (contracts/world.ts):
 * topic slugs, merging per-course generator batches into one deterministic
 * topic list, shape guards for the generated files, placement-ledger
 * resolution, and a cheap lexical candidate ranker for the placer.
 *
 * Imports only from src/core (the import law).
 */

import type {
	CourseTopicsBatch,
	Placement,
	WorldFile,
	WorldTopic,
} from "./contracts/world.ts";

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const sortedUnique = (xs: Iterable<string>): string[] => [...new Set(xs)].sort(cmp);

/** The topic id for a name: lowercase, every run of non-alphanumerics
 *  (including `&`) collapsed to one hyphen, hyphens trimmed. */
export function topicSlug(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

/** Merge per-course batches into the world's topics. Same-slug topics across
 *  degrees/courses become ONE topic (degrees and courses unioned). Prereq
 *  names resolve to ids through topicSlug; a name that resolves to no
 *  generated topic is dropped and reported, and a topic never lists itself.
 *  The result is sorted and deduplicated everywhere, so it is independent of
 *  batch order and a rerun yields identical JSON. */
export function mergeDegreeTopics(batches: CourseTopicsBatch[]): {
	topics: WorldTopic[];
	unresolvedPrereqs: Array<{ topic: string; prereq: string }>;
} {
	interface Acc {
		names: Set<string>;
		scopes: Set<string>;
		degrees: Set<string>;
		courses: Set<string>;
		prereqNames: Set<string>;
	}
	const byId = new Map<string, Acc>();
	for (const batch of batches) {
		for (const t of batch.topics) {
			const id = topicSlug(t.name);
			if (!id) continue;
			let acc = byId.get(id);
			if (!acc) {
				acc = {
					names: new Set(),
					scopes: new Set(),
					degrees: new Set(),
					courses: new Set(),
					prereqNames: new Set(),
				};
				byId.set(id, acc);
			}
			acc.names.add(t.name.trim());
			if (t.scope.trim()) acc.scopes.add(t.scope.trim());
			acc.degrees.add(batch.degree);
			acc.courses.add(batch.course);
			for (const p of t.prereqs) acc.prereqNames.add(p);
		}
	}

	const unresolvedPrereqs: Array<{ topic: string; prereq: string }> = [];
	const topics: WorldTopic[] = [];
	for (const id of [...byId.keys()].sort(cmp)) {
		const acc = byId.get(id) as Acc;
		const prereqs = new Set<string>();
		for (const raw of [...acc.prereqNames].sort(cmp)) {
			const pid = topicSlug(raw);
			if (pid === id) continue;
			if (pid && byId.has(pid)) prereqs.add(pid);
			else unresolvedPrereqs.push({ topic: id, prereq: raw });
		}
		topics.push({
			id,
			// Smallest name by code-unit order — deterministic whatever the
			// batch order (capitalised forms sort before lowercase ones).
			name: [...acc.names].sort(cmp)[0] ?? id,
			scope: sortedUnique(acc.scopes).join("; "),
			degrees: sortedUnique(acc.degrees),
			courses: sortedUnique(acc.courses),
			prereqs: sortedUnique(prereqs),
		});
	}
	return { topics, unresolvedPrereqs };
}

const isObj = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isStrArr = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);

function isWorldTopic(v: unknown): v is WorldTopic {
	if (!isObj(v)) return false;
	if (!isStr(v.id) || !isStr(v.name) || !isStr(v.scope)) return false;
	if (!isStrArr(v.degrees) || !isStrArr(v.courses) || !isStrArr(v.prereqs)) return false;
	if (v.position !== undefined) {
		const p = v.position;
		if (!isObj(p) || typeof p.x !== "number" || typeof p.y !== "number") return false;
	}
	return true;
}

/** Shape guard for the generated world file. */
export function isWorldFile(v: unknown): v is WorldFile {
	if (!isObj(v)) return false;
	if (v.version !== 1 || !isStr(v.generatedAt)) return false;
	if (!Array.isArray(v.degrees) || !Array.isArray(v.topics)) return false;
	if (!v.degrees.every((d) => isObj(d) && isStr(d.id) && isStr(d.name))) return false;
	return v.topics.every(isWorldTopic);
}

/** Shape guard for one generator batch. */
export function isCourseTopicsBatch(v: unknown): v is CourseTopicsBatch {
	if (!isObj(v)) return false;
	if (!isStr(v.degree) || !isStr(v.course) || !Array.isArray(v.topics)) return false;
	return v.topics.every(
		(t) => isObj(t) && isStr(t.name) && isStr(t.scope) && isStrArr(t.prereqs),
	);
}

/** Resolve the append-only placements ledger: per node, the line with the
 *  latest placedAt wins (a tie goes to the later line). Lines for nodes not
 *  in `liveNodeIds` are ignored; a `null` topicId is kept as null. */
export function mergePlacements(
	lines: Placement[],
	liveNodeIds: ReadonlySet<string>,
): Map<string, string | null> {
	const best = new Map<string, Placement>();
	for (const line of lines) {
		if (!liveNodeIds.has(line.nodeId)) continue;
		const cur = best.get(line.nodeId);
		if (!cur || line.placedAt >= cur.placedAt) best.set(line.nodeId, line);
	}
	const merged = new Map<string, string | null>();
	for (const [nodeId, line] of best) merged.set(nodeId, line.topicId);
	return merged;
}

/** Node ids with no placement decision yet, in input order. A node placed as
 *  null counts as placed. */
export function unplacedNodeIds(
	nodeIds: string[],
	merged: Map<string, string | null>,
): string[] {
	return nodeIds.filter((id) => !merged.has(id));
}

/** Lowercased word stems of 4+ letters, trailing "s" stripped. */
function stems(text: string): Set<string> {
	const out = new Set<string>();
	for (const w of text.toLowerCase().match(/[a-z]+/g) ?? []) {
		if (w.length < 4) continue;
		out.add(w.endsWith("s") ? w.slice(0, -1) : w);
	}
	return out;
}

/** The (at most k) topics whose name/scope share the most word stems with
 *  `text` — name hits count double. Zero-overlap topics are never returned;
 *  ties break by id. */
export function topicCandidates(text: string, topics: WorldTopic[], k: number): WorldTopic[] {
	const query = stems(text);
	const scored: Array<{ topic: WorldTopic; score: number }> = [];
	for (const topic of topics) {
		const name = stems(topic.name);
		const scope = stems(topic.scope);
		let score = 0;
		for (const s of query) {
			if (name.has(s)) score += 2;
			else if (scope.has(s)) score += 1;
		}
		if (score > 0) scored.push({ topic, score });
	}
	scored.sort((a, b) => b.score - a.score || cmp(a.topic.id, b.topic.id));
	return scored.slice(0, Math.max(0, k)).map((s) => s.topic);
}
