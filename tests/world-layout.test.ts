/**
 * World layout (core/world-layout.ts) — the permanent positions of the fixed
 * forest. Properties: every topic gets a finite position, the layout is
 * deterministic, positions already set never move, degrees sit at their
 * anchors, shared topics sit between their degrees, prerequisites stay close.
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
	it("declares the eight degrees, each with an anchor", () => {
		assert.deepEqual(
			WORLD_DEGREES.map((d) => d.id),
			["math", "physics", "ee", "cs", "chemistry", "me", "biology", "earth-space"],
		);
		for (const d of WORLD_DEGREES) assert.ok(DEGREE_ANCHORS[d.id], `anchor for ${d.id}`);
	});

	it("gives every topic a finite position", () => {
		const out = layoutWorld(fixture(5), 1);
		assert.equal(out.length, 40);
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

	it("keeps prerequisites closer than random pairs", () => {
		const out = layoutWorld(fixture(6), 1);
		const byId = new Map(out.map((t) => [t.id, t]));
		let preSum = 0;
		let preN = 0;
		for (const t of out) {
			for (const p of t.prereqs) {
				preSum += dist(pos(t), pos(byId.get(p)!));
				preN++;
			}
		}
		let allSum = 0;
		let allN = 0;
		for (let i = 0; i < out.length; i++) {
			for (let j = i + 1; j < out.length; j++) {
				allSum += dist(pos(out[i]!), pos(out[j]!));
				allN++;
			}
		}
		assert.ok(preN > 0);
		assert.ok(preSum / preN < allSum / allN);
	});
});
