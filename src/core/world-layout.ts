/**
 * World layout — the permanent positions of the fixed forest.
 *
 * Each topic is pulled toward its degree anchor(s) (the mean of its degrees'
 * anchors, so a shared topic sits between its degrees), springs link
 * prerequisites together, each topic is pulled toward its course's centroid
 * (so a course clusters, spec §5), and collision keeps topics from stacking. Topics
 * that already have a position are PINNED (fx/fy) and never move: positions
 * are append-only, a new topic is settled around the existing ones.
 *
 * PURE and DETERMINISTIC: same topics + seed → same layout. The prereq graph
 * may contain cycles; d3-force does not care.
 */

import {
	forceCollide,
	forceLink,
	forceManyBody,
	forceSimulation,
	forceX,
	forceY,
	type SimulationLinkDatum,
	type SimulationNodeDatum,
} from "d3-force";
import type { WorldDegree, WorldPosition, WorldTopic } from "./contracts/world.ts";

export const WORLD_DEGREES: readonly WorldDegree[] = [
	{ id: "math", name: "Mathematics" },
	{ id: "physics", name: "Physics" },
	{ id: "ee", name: "Electrical Engineering" },
	{ id: "cs", name: "Computer Science" },
	{ id: "chemistry", name: "Chemistry" },
	{ id: "me", name: "Mechanical Engineering" },
	{ id: "biology", name: "Biology" },
	{ id: "earth-space", name: "Earth & Space Science" },
	{ id: "compe", name: "Computer Engineering" },
	{ id: "civil", name: "Civil Engineering" },
	{ id: "env", name: "Environmental Engineering" },
	{ id: "nuclear", name: "Nuclear Engineering" },
	{ id: "matsci", name: "Materials Science & Engineering" },
	{ id: "bme", name: "Biomedical Engineering" },
];

/** Degree anchors in world units (the approved mockup, ×100). The connecting
 *  engineering degrees sit between the fields they draw on: compe between ee
 *  and cs, civil beside me, env between earth-space, me and civil, nuclear
 *  beside physics toward chemistry, matsci between physics, chemistry and ee,
 *  bme between biology and ee. Their shared topics land between degrees on
 *  their own (anchorOf); the anchor only places the topics unique to them. */
export const DEGREE_ANCHORS: Readonly<Record<string, WorldPosition>> = {
	"earth-space": { x: 14000, y: 11000 },
	math: { x: 32000, y: 27000 },
	physics: { x: 54000, y: 16000 },
	chemistry: { x: 80000, y: 9000 },
	biology: { x: 92000, y: 26000 },
	ee: { x: 76000, y: 30000 },
	cs: { x: 64000, y: 47000 },
	me: { x: 17000, y: 44000 },
	compe: { x: 70000, y: 40000 },
	civil: { x: 6000, y: 50000 },
	env: { x: 3000, y: 30000 },
	nuclear: { x: 60000, y: 3000 },
	matsci: { x: 67000, y: 19000 },
	bme: { x: 88000, y: 40000 },
};

const ANCHOR_STRENGTH = 0.08;
const LINK_DISTANCE = 600;
const LINK_STRENGTH = 0.3;
/** Same-course cohesion: each topic is pulled toward the centroid of its
 *  course(s). It is internal to a course (it never moves a course's centroid),
 *  so degrees stay at their anchors; on a 1800-topic probe it brought
 *  same-course pairs to ~0.4x the distance of other same-degree pairs while
 *  cross-course prerequisites stayed ~0.57x. */
const COURSE_STRENGTH = 0.15;
const COLLIDE_RADIUS = 180;
const CHARGE_STRENGTH = -30;
const TICKS = 600;
/** Half-width of the initial jitter square around a topic's anchor. */
const JITTER = 400;

interface SimNode extends SimulationNodeDatum {
	id: string;
	ax: number;
	ay: number;
}
type SimLink = SimulationLinkDatum<SimNode>;

/** FNV-1a string hash → uint32. */
function hashString(s: string): number {
	let h = 2166136261;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return h >>> 0;
}

/** Seeded linear congruential generator (Numerical Recipes constants) → [0,1). */
function lcg(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
		return s / 4294967296;
	};
}

/** A d3 force pulling every member of a course toward that course's current
 *  centroid (a topic in several courses: toward the mean of their centroids).
 *  Pinned nodes (fx/fy) are not moved by d3 whatever their velocity. */
function forceCourses(groups: number[][], strength: number) {
	let nodes: SimNode[] = [];
	const force = (alpha: number): void => {
		const tx = new Float64Array(nodes.length);
		const ty = new Float64Array(nodes.length);
		const count = new Uint32Array(nodes.length);
		for (const g of groups) {
			let cx = 0;
			let cy = 0;
			for (const i of g) {
				cx += nodes[i]!.x ?? 0;
				cy += nodes[i]!.y ?? 0;
			}
			cx /= g.length;
			cy /= g.length;
			for (const i of g) {
				tx[i]! += cx;
				ty[i]! += cy;
				count[i]!++;
			}
		}
		for (let i = 0; i < nodes.length; i++) {
			const k = count[i]!;
			if (k === 0) continue;
			const n = nodes[i]!;
			n.vx = (n.vx ?? 0) + (tx[i]! / k - (n.x ?? 0)) * strength * alpha;
			n.vy = (n.vy ?? 0) + (ty[i]! / k - (n.y ?? 0)) * strength * alpha;
		}
	};
	force.initialize = (n: SimNode[]): void => {
		nodes = n;
	};
	return force;
}

/** Mean of the anchors of a topic's degrees; unknown degrees are ignored,
 *  and a topic with no known degree falls back to the centroid of all anchors. */
function anchorOf(degrees: readonly string[]): WorldPosition {
	const known = degrees.map((d) => DEGREE_ANCHORS[d]).filter((a): a is WorldPosition => a !== undefined);
	const list = known.length > 0 ? known : Object.values(DEGREE_ANCHORS);
	return {
		x: list.reduce((s, a) => s + a.x, 0) / list.length,
		y: list.reduce((s, a) => s + a.y, 0) / list.length,
	};
}

/**
 * Lay out the world. Returns the same topics (in order), each with a
 * `position`; a topic that already had one keeps it exactly. The input is
 * not mutated.
 */
export function layoutWorld(topics: WorldTopic[], seed: number): WorldTopic[] {
	const nodes: SimNode[] = topics.map((t) => {
		const a = anchorOf(t.degrees);
		const rand = lcg(hashString(t.id) ^ (seed >>> 0));
		const node: SimNode = {
			id: t.id,
			ax: a.x,
			ay: a.y,
			x: t.position ? t.position.x : a.x + (rand() * 2 - 1) * JITTER,
			y: t.position ? t.position.y : a.y + (rand() * 2 - 1) * JITTER,
		};
		if (t.position) {
			node.fx = t.position.x;
			node.fy = t.position.y;
		}
		return node;
	});

	const ids = new Set(nodes.map((n) => n.id));
	const links: SimLink[] = [];
	for (const t of topics) {
		for (const p of t.prereqs) {
			if (p !== t.id && ids.has(p)) links.push({ source: p, target: t.id });
		}
	}

	// Course membership as node indices: courses in sorted order, members in
	// input order, so the same input always gives the same arithmetic.
	const byCourse = new Map<string, Set<number>>();
	topics.forEach((t, i) => {
		for (const c of t.courses) {
			const set = byCourse.get(c) ?? new Set<number>();
			set.add(i);
			byCourse.set(c, set);
		}
	});
	const groups = [...byCourse.keys()]
		.sort()
		.map((c) => [...byCourse.get(c)!].sort((x, y) => x - y))
		.filter((g) => g.length > 1);

	const sim = forceSimulation<SimNode>(nodes)
		.randomSource(lcg(seed))
		.force("x", forceX<SimNode>((d) => d.ax).strength(ANCHOR_STRENGTH))
		.force("y", forceY<SimNode>((d) => d.ay).strength(ANCHOR_STRENGTH))
		.force(
			"link",
			forceLink<SimNode, SimLink>(links)
				.id((d) => d.id)
				.distance(LINK_DISTANCE)
				.strength(LINK_STRENGTH),
		)
		.force("course", forceCourses(groups, COURSE_STRENGTH))
		.force("collide", forceCollide<SimNode>(COLLIDE_RADIUS))
		.force("charge", forceManyBody<SimNode>().strength(CHARGE_STRENGTH))
		.stop();
	sim.tick(TICKS);

	return topics.map((t, i) => {
		if (t.position) return { ...t, position: { x: t.position.x, y: t.position.y } };
		const n = nodes[i]!;
		return { ...t, position: { x: n.x ?? n.ax, y: n.y ?? n.ay } };
	});
}
