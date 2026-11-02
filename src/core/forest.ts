/**
 * Forest logic — pure functions folding the world, the placements ledger and
 * the learner's graph into the forest model (contracts/forest.ts): which topics
 * are lit, where each degree's region sits, which trails the learner's
 * reasoning chains have worn between topics, and how much of the world is
 * mapped.
 *
 * Imports only from src/core (the import law).
 */

import type { GraphChain, GraphNode } from "./contracts/graph.ts";
import type {
	ForestModel,
	ForestRegion,
	ForestTopic,
	ForestTrail,
	IdeaState,
	StateCounts,
} from "./contracts/forest.ts";
import type { Placement, WorldFile, WorldTopic } from "./contracts/world.ts";
import { incrementalLayout, type LayoutEdge } from "./layout.ts";
import { WORLD_DEGREES } from "./world-layout.ts";
import { mergePlacements } from "./world.ts";

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** How brightly a topic glows: 0 when it holds no ideas, else 0.25 plus up to
 *  0.75 by the mean state weight of its ideas (seen 0.3, held 0.7, fast 1.0) —
 *  a lit topic is always visibly lit, and a better-known one is brighter. */
export function topicGlow(counts: StateCounts): number {
	const total = counts.seen + counts.held + counts.fast;
	if (total === 0) return 0;
	const score = (0.3 * counts.seen + 0.7 * counts.held + 1.0 * counts.fast) / total;
	return 0.25 + 0.75 * score;
}

/** Coverage as a percentage string with just enough precision to be non-zero:
 *  whole numbers from 10%, one decimal from 1%, two decimals below that, and
 *  below 0.005% as many decimals as it takes to show a non-zero digit. A
 *  trailing ".0" is dropped. */
export function formatCoverage(mapped: number, total: number): string {
	const p = total > 0 ? (100 * mapped) / total : 0;
	if (p === 0) return "0%";
	let s: string;
	if (p < 1) {
		s = p.toFixed(2);
		for (let digits = 3; /^0\.0+$/.test(s) && digits <= 20; digits++) s = p.toFixed(digits);
	} else if (p < 10) {
		s = p.toFixed(1);
	} else {
		s = p.toFixed(0);
	}
	return `${s.replace(/\.0+$/, "")}%`;
}

/** Fold the world, the placements ledger and the graph into the forest model.
 *  `stateOf` supplies each idea's level-of-knowledge (default: every idea in
 *  the graph is "seen"). Deterministic: same input, same model. */
export function buildForest(
	world: WorldFile,
	placements: readonly Placement[],
	graph: { propositions: readonly GraphNode[]; chains: readonly GraphChain[] },
	stateOf: (nodeId: string) => IdeaState = () => "seen",
): ForestModel {
	const live = new Set(graph.propositions.map((n) => n.id));
	const merged = mergePlacements([...placements], live);

	const positioned = world.topics.filter((t): t is WorldTopic & { position: NonNullable<WorldTopic["position"]> } => !!t.position);
	const byId = new Map(positioned.map((t) => [t.id, t]));

	// Ideas per positioned topic; the rest of the decided nodes are uncharted.
	const ideasOf = new Map<string, string[]>(positioned.map((t) => [t.id, []]));
	const uncharted: string[] = [];
	for (const [nodeId, topicId] of merged) {
		const ideas = topicId === null ? undefined : ideasOf.get(topicId);
		if (ideas) ideas.push(nodeId);
		else uncharted.push(nodeId);
	}
	uncharted.sort(cmp);

	const topics: ForestTopic[] = positioned.map((t) => {
		const ideas = (ideasOf.get(t.id) as string[]).sort(cmp);
		const counts: StateCounts = { seen: 0, held: 0, fast: 0 };
		for (const id of ideas) counts[stateOf(id)]++;
		return {
			id: t.id,
			name: t.name,
			scope: t.scope,
			degrees: [...t.degrees],
			x: t.position.x,
			y: t.position.y,
			ideas,
			counts,
			glow: topicGlow(counts),
		};
	});

	return {
		topics,
		regions: regionsOf(world, topics),
		trails: trailsOf(graph.chains, merged, byId),
		uncharted,
		unplaced: graph.propositions.filter((n) => !merged.has(n.id)).length,
		unpositioned: world.topics.length - positioned.length,
		coverage: { mapped: topics.filter((t) => t.ideas.length > 0).length, total: topics.length },
	};
}

/** One region per degree that has a positioned topic, at the centroid of the
 *  topics whose ONLY degree it is (a topic shared across degrees, like "Limits",
 *  would drag every region toward the middle); a degree with no exclusive topic
 *  falls back to all its topics. `topics` counts all of the degree's topics. Ordered as the world lists its degrees, any others by id. The name
 *  comes from the world's degrees, then the built-in WORLD_DEGREES, then the id. */
function regionsOf(world: WorldFile, topics: readonly ForestTopic[]): ForestRegion[] {
	const members = new Map<string, ForestTopic[]>();
	for (const t of topics) {
		for (const d of t.degrees) {
			const list = members.get(d);
			if (list) list.push(t);
			else members.set(d, [t]);
		}
	}
	const names = new Map<string, string>();
	for (const d of WORLD_DEGREES) names.set(d.id, d.name);
	for (const d of world.degrees) names.set(d.id, d.name);

	const listed = world.degrees.map((d) => d.id).filter((id) => members.has(id));
	const rest = [...members.keys()].filter((id) => !listed.includes(id)).sort(cmp);
	return [...new Set([...listed, ...rest])].map((degreeId) => {
		const all = members.get(degreeId) as ForestTopic[];
		const own = all.filter((t) => t.degrees.length === 1);
		const ts = own.length > 0 ? own : all;
		return {
			degreeId,
			name: names.get(degreeId) ?? degreeId,
			x: ts.reduce((s, t) => s + t.x, 0) / ts.length,
			y: ts.reduce((s, t) => s + t.y, 0) / ts.length,
			topics: all.length,
		};
	});
}

/** Trails: for each chain, every pair of distinct positioned topics among its
 *  premises and conclusion gains one chain. Members that are dead, unplaced or
 *  uncharted contribute nothing, and a chain inside one topic makes no trail. */
function trailsOf(
	chains: readonly GraphChain[],
	merged: ReadonlyMap<string, string | null>,
	byId: ReadonlyMap<string, WorldTopic>,
): ForestTrail[] {
	const counts = new Map<string, ForestTrail>();
	for (const chain of chains) {
		const touched = new Set<string>();
		for (const id of [...chain.premises, chain.conclusion]) {
			const topicId = merged.get(id);
			if (topicId && byId.has(topicId)) touched.add(topicId);
		}
		const ids = [...touched].sort(cmp);
		for (let i = 0; i < ids.length; i++) {
			for (let j = i + 1; j < ids.length; j++) {
				const a = ids[i] as string;
				const b = ids[j] as string;
				const key = `${a}\u0000${b}`;
				const trail = counts.get(key);
				if (trail) trail.chains++;
				else {
					const aDegrees = (byId.get(a) as WorldTopic).degrees;
					const bDegrees = (byId.get(b) as WorldTopic).degrees;
					counts.set(key, { a, b, chains: 1, crossDegree: !aDegrees.some((d) => bDegrees.includes(d)) });
				}
			}
		}
	}
	return [...counts.values()].sort((x, y) => cmp(x.a, y.a) || cmp(x.b, y.b));
}

// ── Geometry: levels of detail, culling, labels, clearings ───────────────────

/** Zoom below this: the world level (regions only). */
export const REGION_K = 0.12;
/** Zoom at or above this: the clearing level (one topic's ideas). */
export const CLEARING_K = 1.2;
/** A clearing's radius in world units (topic collide radius is 180). */
export const CLEARING_R = 160;
/** Topic labels drawn per frame at most. */
export const LABEL_BUDGET = 300;

export type ForestLevel = "world" | "region" | "clearing";

export function forestLevel(k: number): ForestLevel {
	if (k < REGION_K) return "world";
	if (k < CLEARING_K) return "region";
	return "clearing";
}

/** The view transform: screen = world * k + (x, y). */
export interface ForestCamera {
	k: number;
	x: number;
	y: number;
}

/** Topics whose screen point lies in the w×h viewport grown by `padPx`. One
 *  pass, input order kept. */
export function visibleTopics(
	topics: readonly ForestTopic[],
	cam: ForestCamera,
	w: number,
	h: number,
	padPx: number,
): ForestTopic[] {
	const out: ForestTopic[] = [];
	const minX = -padPx;
	const maxX = w + padPx;
	const minY = -padPx;
	const maxY = h + padPx;
	for (const t of topics) {
		const sx = t.x * cam.k + cam.x;
		const sy = t.y * cam.k + cam.y;
		if (sx >= minX && sx <= maxX && sy >= minY && sy <= maxY) out.push(t);
	}
	return out;
}

const nameCollator = new Intl.Collator("en");

/** Label order: brighter first, then name (collator order), then id. */
function labelOrder(a: ForestTopic, b: ForestTopic): number {
	return b.glow - a.glow || nameCollator.compare(a.name, b.name) || cmp(a.id, b.id);
}

/** The topics to label: lit before fogged, brighter before dimmer, then by name
 *  and id; at most `budget`. Does not mutate `topics`. A bounded top-k
 *  selection (O(n log budget), name compared only on glow ties that could still
 *  make the cut) — pass the culled `visibleTopics` output, not the whole forest. */
export function pickLabels(topics: readonly ForestTopic[], budget: number): ForestTopic[] {
	const k = Math.floor(budget);
	if (!(k > 0)) return [];
	const best: ForestTopic[] = []; // sorted by labelOrder, length <= k
	for (const t of topics) {
		if (best.length === k && labelOrder(t, best[k - 1] as ForestTopic) >= 0) continue;
		let lo = 0;
		let hi = best.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (labelOrder(best[mid] as ForestTopic, t) <= 0) lo = mid + 1;
			else hi = mid;
		}
		best.splice(lo, 0, t);
		if (best.length > k) best.pop();
	}
	return best;
}

/** Lay one topic's ideas out in a clearing: the chains' premise→conclusion
 *  links become springs (chains reaching outside `ideaIds` are ignored), the
 *  result is centred on `center` and scaled so the farthest idea sits at 0.85 of
 *  `radius`. Deterministic; ids are sorted first so input order is irrelevant. */
export function layoutClearing(
	ideaIds: readonly string[],
	chains: readonly GraphChain[],
	center: { x: number; y: number },
	radius: number,
): Map<string, { x: number; y: number }> {
	const ids = [...new Set(ideaIds)].sort(cmp);
	const out = new Map<string, { x: number; y: number }>();
	if (ids.length === 0) return out;
	if (ids.length === 1) {
		out.set(ids[0] as string, { x: center.x, y: center.y });
		return out;
	}

	const inSet = new Set(ids);
	const edges: LayoutEdge[] = [];
	for (const c of chains) {
		if (!inSet.has(c.conclusion)) continue;
		for (const p of c.premises) if (p !== c.conclusion && inSet.has(p)) edges.push({ from: p, to: c.conclusion });
	}
	edges.sort((a, b) => cmp(a.from, b.from) || cmp(a.to, b.to));

	const laid = incrementalLayout(ids.map((id) => ({ id })), edges, new Map());
	let cx = 0;
	let cy = 0;
	for (const p of laid.values()) {
		cx += p.x;
		cy += p.y;
	}
	cx /= laid.size;
	cy /= laid.size;
	let far = 0;
	for (const p of laid.values()) far = Math.max(far, Math.hypot(p.x - cx, p.y - cy));
	const scale = far > 1e-9 ? (0.85 * radius) / far : 0;
	for (const id of ids) {
		const p = laid.get(id) as { x: number; y: number };
		out.set(id, { x: center.x + (p.x - cx) * scale, y: center.y + (p.y - cy) * scale });
	}
	return out;
}
