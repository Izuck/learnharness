/**
 * World layout (core/world-layout.ts) — the permanent positions of the fixed
 * forest. Properties: every topic gets a finite position, the layout is
 * deterministic, positions already set never move, degrees sit at their
 * anchors, shared topics sit between their degrees, prerequisites stay close,
 * topics of one course cluster.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { WorldPosition, WorldTopic } from "../src/core/contracts/world.ts";
import { DEGREE_ANCHORS, WORLD_DEGREES, layoutWorld } from "../src/core/world-layout.ts";

const topic = (id: string, degrees: string[], prereqs: string[] = [], position?: WorldPosition): WorldTopic => ({
	id,
	name: id,
	scope: id,
	degrees,
	courses: [],
	prereqs,
	...(position ? { position } : {}),
});

const dist = (a: WorldPosition, b: WorldPosition): number => Math.hypot(a.x - b.x, a.y - b.y);
const pos = (t: WorldTopic): WorldPosition => {
	assert.ok(t.position, `${t.id} has no position`);
	return t.position;
};

const mean = (xs: number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length;

/** Distances of every unordered pair of single-degree topics in the same degree that pass `keep`. */
function sameDegreePairs(out: WorldTopic[], keep: (a: WorldTopic, b: WorldTopic) => boolean): number[] {
	const ds: number[] = [];
	for (let i = 0; i < out.length; i++) {
		for (let j = i + 1; j < out.length; j++) {
			const a = out[i]!;
			const b = out[j]!;
			if (a.degrees.length !== 1 || b.degrees.length !== 1 || a.degrees[0] !== b.degrees[0]) continue;
			if (keep(a, b)) ds.push(dist(pos(a), pos(b)));
		}
	}
	return ds;
}

/** Small deterministic fixture: `perDegree` topics per degree, chained by
 *  prereqs inside the degree, plus a few cross-degree prereq links. */
function fixture(perDegree: number): WorldTopic[] {
	const out: WorldTopic[] = [];
	for (const d of WORLD_DEGREES) {
		for (let i = 0; i < perDegree; i++) {
			out.push(topic(`${d.id}-${i}`, [d.id], i === 0 ? [] : [`${d.id}-${i - 1}`]));
		}
	}
	out.find((t) => t.id === "physics-2")!.prereqs.push("math-1");
	out.find((t) => t.id === "ee-2")!.prereqs.push("physics-1");
	out.find((t) => t.id === "cs-2")!.prereqs.push("math-0");
	return out;
}

describe("world layout", () => {
	it("declares the twelve degrees, each with an anchor", () => {
		assert.deepEqual(
			WORLD_DEGREES.map((d) => d.id),
			["math", "physics", "ee", "cs", "chemistry", "me", "biology", "earth-space", "compe", "civil", "env", "nuclear"],
		);
		for (const d of WORLD_DEGREES) assert.ok(DEGREE_ANCHORS[d.id], `anchor for ${d.id}`);
	});

	it("gives every topic a finite position", () => {
		const out = layoutWorld(fixture(5), 1);
		assert.equal(out.length, WORLD_DEGREES.length * 5);
		for (const t of out) {
			const p = pos(t);
			assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), t.id);
		}
	});

	it("is deterministic", () => {
		assert.deepEqual(layoutWorld(fixture(5), 7), layoutWorld(fixture(5), 7));
	});

	it("tolerates prerequisite cycles and dangling prereqs", () => {
		const t = [topic("a", ["math"], ["b", "ghost"]), topic("b", ["math"], ["a"]), topic("c", ["cs"], ["c"])];
		for (const x of layoutWorld(t, 3)) assert.ok(Number.isFinite(pos(x).x));
	});

	it("never moves a position that was already set", () => {
		const first = layoutWorld(fixture(5).slice(0, 30), 7);
		const added = [
			...first,
			...["n1", "n2", "n3", "n4", "n5"].map((id) => topic(id, ["math", "cs"], ["math-0"])),
		];
		const second = layoutWorld(added, 7);
		assert.equal(second.length, 35);
		for (let i = 0; i < 30; i++) assert.deepEqual(second[i]!.position, first[i]!.position, first[i]!.id);
		for (const t of second.slice(30)) assert.ok(Number.isFinite(pos(t).x) && Number.isFinite(pos(t).y));
	});

	it("keeps each degree near its anchor", () => {
		const out = layoutWorld(fixture(6), 1);
		for (const d of WORLD_DEGREES) {
			const own = out.filter((t) => t.degrees.length === 1 && t.degrees[0] === d.id);
			const mean = {
				x: own.reduce((s, t) => s + pos(t).x, 0) / own.length,
				y: own.reduce((s, t) => s + pos(t).y, 0) / own.length,
			};
			const nearest = Object.entries(DEGREE_ANCHORS).sort((a, b) => dist(mean, a[1]) - dist(mean, b[1]))[0]![0];
			assert.equal(nearest, d.id);
		}
	});

	it("places shared topics between their degrees", () => {
		const t = [...fixture(4), topic("shared", ["math", "physics"])];
		const shared = pos(layoutWorld(t, 1).find((x) => x.id === "shared")!);
		const a = DEGREE_ANCHORS.math!;
		const b = DEGREE_ANCHORS.physics!;
		const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
		assert.ok(dist(shared, mid) < dist(shared, a));
		assert.ok(dist(shared, mid) < dist(shared, b));
	});

	it("keeps prerequisites closer than random same-degree pairs", () => {
		const out = layoutWorld(fixture(12), 1);
		const byId = new Map(out.map((t) => [t.id, t]));
		const linked = new Set<string>();
		const pre: number[] = [];
		for (const t of out) {
			for (const p of t.prereqs) {
				const other = byId.get(p)!;
				if (other.degrees[0] !== t.degrees[0]) continue; // same-degree prereqs only
				pre.push(dist(pos(t), pos(other)));
				linked.add(`${p}|${t.id}`).add(`${t.id}|${p}`);
			}
		}
		const same = sameDegreePairs(out, (a, b) => !linked.has(`${a.id}|${b.id}`));
		assert.ok(pre.length > 0 && same.length > 0);
		assert.ok(mean(pre) < 0.7 * mean(same), `prereq ${mean(pre)} vs same-degree ${mean(same)}`);
	});

	it("clusters topics that share a course", () => {
		// 2 degrees x 6 courses x 10 topics, no prereqs: only the course can pull pairs together.
		const t: WorldTopic[] = [];
		for (const d of ["math", "physics"]) {
			for (let c = 0; c < 6; c++) {
				for (let i = 0; i < 10; i++) {
					// ids interleave courses so id order alone does not group them
					t.push({ ...topic(`${d}-${i}-${c}`, [d]), courses: [`${d} course ${c}`] });
				}
			}
		}
		const out = layoutWorld(t, 1);
		const sameCourse = sameDegreePairs(out, (a, b) => a.courses[0] === b.courses[0]);
		const otherCourse = sameDegreePairs(out, (a, b) => a.courses[0] !== b.courses[0]);
		assert.ok(
			mean(sameCourse) < 0.7 * mean(otherCourse),
			`same course ${mean(sameCourse)} vs other course ${mean(otherCourse)}`,
		);
	});

	it("the course pull is deterministic and never moves pinned positions", () => {
		const calc = ["a", "b", "c"].map((id) => ({ ...topic(id, ["math"]), courses: ["Calc", "Analysis"] }));
		assert.deepEqual(layoutWorld(calc, 7), layoutWorld(calc, 7));
		const first = layoutWorld(calc, 7);
		const added = [...first, { ...topic("d", ["math"]), courses: ["Calc"] }];
		const second = layoutWorld(added, 7);
		for (let i = 0; i < 3; i++) assert.deepEqual(second[i]!.position, first[i]!.position);
		assert.ok(Number.isFinite(pos(second[3]!).x));
	});
});
