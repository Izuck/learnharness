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
	TopicMerges,
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
 *  batch order and a rerun yields identical JSON.
 *
 *  `aliases` (aliasMap) folds same-concept topics: every topic id and every
 *  prereq id is first mapped to its canonical id, so aliases merge into the
 *  canonical topic (degrees, courses, scopes and prereqs unioned) and a prereq
 *  that pointed at an alias points at the canonical one. `canonicalNames`
 *  (canonicalNameMap) gives a canonical topic its chosen name in place of the
 *  smallest member name. With neither, the output is exactly as before. */
export function mergeDegreeTopics(
	batches: CourseTopicsBatch[],
	aliases?: ReadonlyMap<string, string>,
	canonicalNames?: ReadonlyMap<string, string>,
): {
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
	const resolve = (id: string): string => aliases?.get(id) ?? id;
	const byId = new Map<string, Acc>();
	for (const batch of batches) {
		for (const t of batch.topics) {
			const id = resolve(topicSlug(t.name));
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
			const pid = resolve(topicSlug(raw));
			if (pid === id) continue;
			if (pid && byId.has(pid)) prereqs.add(pid);
			else unresolvedPrereqs.push({ topic: id, prereq: raw });
		}
		topics.push({
			id,
			// Smallest name by code-unit order — deterministic whatever the
			// batch order (capitalised forms sort before lowercase ones).
			name: canonicalNames?.get(id) ?? [...acc.names].sort(cmp)[0] ?? id,
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
	if (v.anchors !== undefined) {
		if (!isObj(v.anchors)) return false;
		if (!Object.values(v.anchors).every((p) => isObj(p) && Number.isFinite(p.x) && Number.isFinite(p.y))) return false;
	}
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

/** Carry layout positions from a previous world into freshly merged topics,
 *  by topic id: a topic's position never changes once saved. New topics stay
 *  unpositioned; topics absent from `next` are dropped. */
export function carryPositions(next: WorldTopic[], prev: WorldFile | null): WorldTopic[] {
	if (!prev) return next;
	const old = new Map<string, WorldTopic["position"]>();
	for (const t of prev.topics) if (t.position) old.set(t.id, t.position);
	return next.map((t) => {
		const position = old.get(t.id);
		return position ? { ...t, position: { ...position } } : t;
	});
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

/** English function words and filler that carry no topic signal. Compared
 *  against the lowercased word before stemming. */
const STOPWORDS: ReadonlySet<string> = new Set(
	(
		"am an as at be by do he if in is it me my no of on or so to up us we " +
		"about above after again against all also although among and any are around because been before " +
		"being below between both but can cannot could did does doing done during each either else even " +
		"every few for from further had has have having her here hers him his how however into its itself " +
		"just many may might more most much must nor not now off once one only onto other others our out " +
		"over own per rather same she should since some such than that the their theirs them then there " +
		"these they this those though three through thus too two under until upon use used uses using very " +
		"via was way were what when where whether which while who whom whose why will with within without " +
		"would yet you your"
	).split(" "),
);

/** Lowercased content-word stems of 2+ letters (stopwords dropped; short
 *  acronyms like PN, RC, DNA, ODE stay), a trailing "s" stripped from words
 *  longer than 3 letters (not from "-ss"). */
function stems(text: string): Set<string> {
	const out = new Set<string>();
	for (const w of text.toLowerCase().match(/[a-z]+/g) ?? []) {
		if (w.length < 2 || STOPWORDS.has(w)) continue;
		out.add(w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);
	}
	return out;
}

/** The (at most k) topics whose name/scope best match `text` by shared
 *  content-word stems. Each shared stem scores its rarity over the given
 *  topics (IDF: ln(1 + N/df), so a stem few topics use outweighs one most
 *  topics share), doubled when it is in the topic's name rather than only its
 *  scope. Stopwords never count. Zero-overlap topics are never returned; ties
 *  break by id. Pure and deterministic. */
export function topicCandidates(text: string, topics: WorldTopic[], k: number): WorldTopic[] {
	const query = stems(text);
	if (query.size === 0 || k <= 0) return [];
	const indexed = topics.map((topic) => ({ topic, name: stems(topic.name), scope: stems(topic.scope) }));
	const df = new Map<string, number>();
	for (const q of query) {
		let n = 0;
		for (const t of indexed) if (t.name.has(q) || t.scope.has(q)) n++;
		df.set(q, n);
	}
	const scored: Array<{ topic: WorldTopic; score: number }> = [];
	for (const t of indexed) {
		let score = 0;
		for (const q of query) {
			const weight = t.name.has(q) ? 2 : t.scope.has(q) ? 1 : 0;
			if (weight > 0) score += weight * Math.log(1 + indexed.length / df.get(q)!);
		}
		if (score > 0) scored.push({ topic: t.topic, score });
	}
	scored.sort((a, b) => b.score - a.score || cmp(a.topic.id, b.topic.id));
	return scored.slice(0, k).map((s) => s.topic);
}

// ─── dedupe: same-concept topics named slightly differently ─────────────────

/** Name filler: the shared stopwords (minus number words and negations, which
 *  change a topic's meaning) plus "a" and introduction-style fluff. */
const NAME_STOPWORDS: ReadonlySet<string> = new Set([
	...[...STOPWORDS].filter((w) => !["one", "two", "three", "no", "not"].includes(w)),
	"a",
	"introduction",
	"introductory",
	"intro",
]);

/** A cheap plural stemmer for topic names: -ies to -y, -xes/-ches/-shes/-sses
 *  drop "es", any other trailing "s" goes unless the word ends in -ss, -us or
 *  -is. Words of 3 letters or fewer are left alone, as are "series" and
 *  "species" (their own singulars). */
function stemNameWord(w: string): string {
	if (w.length <= 3 || w === "series" || w === "species") return w;
	if (w.endsWith("ies") && w.length > 4) return `${w.slice(0, -3)}y`;
	if (/(x|ch|sh|ss|zz)es$/.test(w)) return w.slice(0, -2);
	if (w.endsWith("s") && !/(ss|us|is)$/.test(w)) return w.slice(0, -1);
	return w;
}

/** The sorted, distinct content stems of a topic name: lower-case, possessive
 *  "'s" and punctuation removed, stop words and "introduction" dropped, plural
 *  endings stripped. Letters and digits are kept (so "Calculus I" is not
 *  "Calculus"). */
export function topicNameStems(name: string): string[] {
	const words = name
		.toLowerCase()
		.replace(/['’]s\b/g, "")
		.replace(/['’]/g, "")
		.match(/[a-z0-9]+/g);
	const out = new Set<string>();
	for (const w of words ?? []) {
		if (NAME_STOPWORDS.has(w)) continue;
		out.add(stemNameWord(w));
	}
	return [...out].sort(cmp);
}

/** A topic name's dedupe key: its stems joined by a space. Names differing
 *  only in case, plurals, stop words, "introduction" or word order share a
 *  key. Empty when the name is only filler. */
export function normaliseTopicName(name: string): string {
	return topicNameStems(name).join(" ");
}

/** The key of a candidate group in TopicMerges.decisions: member ids sorted
 *  and joined with "|". */
export function decisionKey(ids: readonly string[]): string {
	return [...ids].sort(cmp).join("|");
}

export interface DedupeCandidateOptions {
	/** Minimum token-set Jaccard for a fuzzy pair (default 0.6). */
	threshold?: number;
	/** Largest group returned (default 6). */
	maxGroup?: number;
}

/** Groups of topic ids that may be the same concept, for a model to judge.
 *  Two sources: exact normalised-key collisions, and fuzzy pairs whose stem
 *  sets have Jaccard >= threshold and which share no course (a course never
 *  lists the same topic twice on purpose). Pairs come from an inverted index,
 *  so this is not O(n^2) in the topic count. Pairs are unioned into groups,
 *  best pairs first (key collisions, then higher Jaccard, then ids), a union
 *  being refused when the group would exceed maxGroup - so a big cluster is
 *  split along its best pairs and loses no member. Each group's ids are sorted
 *  and the groups are sorted; the result does not depend on input order. Which
 *  groups are already decided is the caller's concern. */
export function dedupeCandidates(
	topics: readonly WorldTopic[],
	opts: DedupeCandidateOptions = {},
): string[][] {
	const threshold = opts.threshold ?? 0.6;
	const maxGroup = Math.max(2, opts.maxGroup ?? 6);

	interface Item {
		id: string;
		stems: string[];
		key: string;
		courses: ReadonlySet<string>;
	}
	const items: Item[] = [];
	const seen = new Set<string>();
	for (const t of [...topics].sort((a, b) => cmp(a.id, b.id))) {
		if (seen.has(t.id)) continue;
		seen.add(t.id);
		const stemList = topicNameStems(t.name);
		if (stemList.length === 0) continue;
		items.push({ id: t.id, stems: stemList, key: stemList.join(" "), courses: new Set(t.courses) });
	}

	// Edges are between item indexes (items are id-sorted, so a < b is id order).
	const edges = new Map<string, { a: number; b: number; w: number }>();
	const addEdge = (a: number, b: number, w: number): void => {
		const [lo, hi] = a < b ? [a, b] : [b, a];
		const k = `${lo}|${hi}`;
		const cur = edges.get(k);
		if (!cur || cur.w < w) edges.set(k, { a: lo, b: hi, w });
	};

	// (a) exact normalised-key collisions
	const byKey = new Map<string, number[]>();
	items.forEach((it, i) => {
		const list = byKey.get(it.key);
		if (list) list.push(i);
		else byKey.set(it.key, [i]);
	});
	for (const list of byKey.values()) {
		for (let x = 0; x < list.length; x++) {
			for (let y = x + 1; y < list.length; y++) addEdge(list[x] as number, list[y] as number, 1);
		}
	}

	// (b) fuzzy pairs through an inverted index over stems
	const postings = new Map<string, number[]>();
	items.forEach((it, i) => {
		for (const s of it.stems) {
			const list = postings.get(s);
			if (list) list.push(i);
			else postings.set(s, [i]);
		}
	});
	items.forEach((it, i) => {
		const shared = new Map<number, number>();
		for (const s of it.stems) {
			for (const j of postings.get(s) ?? []) if (j > i) shared.set(j, (shared.get(j) ?? 0) + 1);
		}
		for (const [j, n] of shared) {
			const other = items[j] as Item;
			const jaccard = n / (it.stems.length + other.stems.length - n);
			if (jaccard + 1e-9 < threshold) continue;
			let sameCourse = false;
			for (const c of it.courses) if (other.courses.has(c)) sameCourse = true;
			if (!sameCourse) addEdge(i, j, jaccard);
		}
	});

	// Union the best edges first, never beyond maxGroup.
	const parent = items.map((_, i) => i);
	const size = items.map(() => 1);
	const find = (x: number): number => {
		let r = x;
		while (parent[r] !== r) r = parent[r] as number;
		while (parent[x] !== r) {
			const next = parent[x] as number;
			parent[x] = r;
			x = next;
		}
		return r;
	};
	const ordered = [...edges.values()].sort((p, q) => q.w - p.w || p.a - q.a || p.b - q.b);
	for (const e of ordered) {
		const ra = find(e.a);
		const rb = find(e.b);
		if (ra === rb || (size[ra] as number) + (size[rb] as number) > maxGroup) continue;
		parent[rb] = ra;
		size[ra] = (size[ra] as number) + (size[rb] as number);
	}
	const groups = new Map<number, string[]>();
	items.forEach((it, i) => {
		const r = find(i);
		const list = groups.get(r);
		if (list) list.push(it.id);
		else groups.set(r, [it.id]);
	});
	return [...groups.values()]
		.filter((g) => g.length >= 2)
		.map((g) => g.sort(cmp))
		.sort((p, q) => cmp(p.join("|"), q.join("|")));
}

/** One usable same:true decision. */
export interface ActiveMerge {
	key: string;
	members: string[];
	canonicalId: string;
	canonicalName: string;
	reason: string;
}

/** The decisions' resolution: those that apply, and those skipped because
 *  their canonical id collides (see activeMerges). */
function resolveMerges(
	merges: TopicMerges,
	topicIds: ReadonlySet<string>,
): { active: ActiveMerge[]; collisions: ActiveMerge[] } {
	const all: ActiveMerge[] = [];
	for (const [key, d] of Object.entries(merges.decisions)) {
		if (!d.same) continue;
		const name = (d.canonical ?? "").trim();
		const canonicalId = topicSlug(name);
		const members = key.split("|").filter((m) => m !== "");
		if (!canonicalId || members.length < 2) continue;
		all.push({ key, members, canonicalId, canonicalName: name, reason: d.reason });
	}
	const decidedAt = (m: ActiveMerge): string => merges.decisions[m.key]?.decidedAt ?? "";
	all.sort((p, q) => cmp(decidedAt(p), decidedAt(q)) || cmp(p.key, q.key));

	const applying = new Set<ActiveMerge>();
	const collided = new Set<ActiveMerge>();
	// canonical id -> ids of the decisions applied under it (members and the id).
	const claims = new Map<string, Set<string>>();
	const known = new Set(topicIds);
	let grew = true;
	while (grew) {
		grew = false;
		for (const m of all) {
			if (applying.has(m) || collided.has(m) || !m.members.every((id) => known.has(id))) continue;
			// A canonical name that is another raw topic, or that another decision
			// (with no member in common) already claimed, would silently absorb
			// unrelated topics into it.
			const claimed = claims.get(m.canonicalId);
			if (
				(topicIds.has(m.canonicalId) && !m.members.includes(m.canonicalId)) ||
				(claimed !== undefined && !m.members.some((id) => claimed.has(id)))
			) {
				collided.add(m);
				continue;
			}
			applying.add(m);
			known.add(m.canonicalId);
			const set = claims.get(m.canonicalId) ?? new Set<string>();
			for (const id of m.members) set.add(id);
			set.add(m.canonicalId);
			claims.set(m.canonicalId, set);
			grew = true;
		}
	}
	return { active: all.filter((m) => applying.has(m)), collisions: all.filter((m) => collided.has(m)) };
}

/** The same:true decisions that still apply, oldest first (decidedAt, then
 *  key). A decision applies when it names a canonical whose slug is non-empty
 *  and every member still exists - as a topic id in `topicIds`, or as the
 *  canonical id of another applying decision (a canonical name the model coined
 *  that no course used). A decision is skipped (see mergeCollisions) when its
 *  canonical id is a raw topic that is not one of its members, or was already
 *  claimed by an earlier decision sharing no member with it: either would
 *  fold unrelated topics together. Resolved to a fixed point, so the result
 *  does not depend on object key order. */
export function activeMerges(merges: TopicMerges, topicIds: ReadonlySet<string>): ActiveMerge[] {
	return resolveMerges(merges, topicIds).active;
}

/** The same:true decisions skipped by activeMerges because their canonical id
 *  collides with an unrelated topic or decision, so a caller can report them. */
export function mergeCollisions(merges: TopicMerges, topicIds: ReadonlySet<string>): ActiveMerge[] {
	return resolveMerges(merges, topicIds).collisions;
}

/** Merged-away topic id -> canonical id, from the same:true decisions that
 *  still apply (activeMerges). The canonical id is topicSlug(canonical name).
 *  Chains resolve transitively (a to b, b to c gives a to c); a cycle is broken
 *  at its smallest id, which becomes the root. Targets are final: no target is
 *  itself a key. A later decision overrides an earlier one for the same member. */
export function aliasMap(merges: TopicMerges, topicIds: ReadonlySet<string>): Map<string, string> {
	const edges = new Map<string, string>();
	for (const m of activeMerges(merges, topicIds)) {
		for (const id of m.members) if (id !== m.canonicalId) edges.set(id, m.canonicalId);
	}

	// Break cycles: each node has one outgoing edge, so walk from every node
	// and cut the smallest id of any cycle found.
	const state = new Map<string, 1 | 2>();
	for (const start of [...edges.keys()].sort(cmp)) {
		if (state.has(start)) continue;
		const path: string[] = [];
		let cur: string | undefined = start;
		while (cur !== undefined && !state.has(cur)) {
			state.set(cur, 1);
			path.push(cur);
			cur = edges.get(cur);
		}
		if (cur !== undefined && state.get(cur) === 1) {
			const cycle = path.slice(path.indexOf(cur));
			edges.delete([...cycle].sort(cmp)[0] as string);
		}
		for (const p of path) state.set(p, 2);
	}

	const out = new Map<string, string>();
	for (const from of [...edges.keys()].sort(cmp)) {
		let to = edges.get(from) as string;
		while (edges.has(to)) to = edges.get(to) as string;
		out.set(from, to);
	}
	return out;
}

/** Canonical topic id -> canonical name, from the decisions that still apply;
 *  the latest decision wins when two name the same id. For mergeDegreeTopics'
 *  `canonicalNames`. */
export function canonicalNameMap(merges: TopicMerges, topicIds: ReadonlySet<string>): Map<string, string> {
	const out = new Map<string, string>();
	for (const m of activeMerges(merges, topicIds)) out.set(m.canonicalId, m.canonicalName);
	return out;
}

/** The new placement lines that move every node whose latest placement is a
 *  merged-away topic onto its canonical topic. `latest` is the resolved ledger
 *  (mergePlacements); nodes placed on no topic (null) or on a topic that was
 *  not merged away produce nothing, so a rerun yields no lines. Sorted by node
 *  id. The ledger is append-only: these are new lines, nothing is rewritten. */
export function repointPlacements(
	latest: ReadonlyMap<string, string | null>,
	aliases: ReadonlyMap<string, string>,
	placedAt: string,
): Placement[] {
	const out: Placement[] = [];
	for (const [nodeId, topicId] of latest) {
		const canonical = topicId === null ? undefined : aliases.get(topicId);
		if (canonical !== undefined) out.push({ nodeId, topicId: canonical, placedAt });
	}
	return out.sort((a, b) => cmp(a.nodeId, b.nodeId));
}

/** Shape guard for build/merges.json. */
export function isTopicMerges(v: unknown): v is TopicMerges {
	if (!isObj(v) || v.version !== 1 || !isObj(v.decisions)) return false;
	return Object.values(v.decisions).every(
		(d) =>
			isObj(d) &&
			typeof d.same === "boolean" &&
			isStr(d.reason) &&
			isStr(d.decidedAt) &&
			(d.canonical === undefined || isStr(d.canonical)),
	);
}
