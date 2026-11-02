/**
 * World anchors (core/world-anchors.ts) — degree anchors derived from topic
 * overlap by classical MDS, aligned to the hand-drawn map. Properties: the
 * Jacobi eigen routine and MDS are exact on known inputs, a topic shared by k
 * degrees weighs 1/(k−1), heavily overlapping degrees end up close, degrees
 * with too little data keep their fallback, and the result is deterministic.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { WorldPosition, WorldTopic } from "../src/core/contracts/world.ts";
import {
	classicalMds,
	degreeDistances,
	deriveDegreeAnchors,
	embeddingStress,
	fitSimilarity,
	jacobiEigen,
} from "../src/core/world-anchors.ts";

const near = (a: number, b: number, tol = 1e-9): void => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}`);
const dist = (a: WorldPosition, b: WorldPosition): number => Math.hypot(a.x - b.x, a.y - b.y);

let counter = 0;
/** `n` fresh topics, each taught by exactly `degrees`. */
function topics(n: number, degrees: string[]): WorldTopic[] {
	const out: WorldTopic[] = [];
	for (let i = 0; i < n; i++) {
		counter++;
		out.push({
			id: `t${counter}`,
			name: `t${counter}`,
			scope: "s",
			degrees: [...degrees].sort(),
			courses: [],
			prereqs: [],
		});
	}
	return out;
}

/** Four fallback anchors on a square, deliberately NOT matching the data. */
const SQUARE: Record<string, WorldPosition> = {
	a: { x: 0, y: 0 },
	b: { x: 1000, y: 0 },
	c: { x: 0, y: 1000 },
	d: { x: 1000, y: 1000 },
};

/** a+b overlap heavily, c+d overlap heavily, the two pairs share nothing. */
const twoPairs = (): WorldTopic[] => [
	...topics(8, ["a", "b"]),
	...topics(8, ["c", "d"]),
	...topics(2, ["a"]),
	...topics(2, ["b"]),
	...topics(2, ["c"]),
	...topics(2, ["d"]),
];

describe("world anchors: jacobiEigen", () => {
	it("finds the eigenvalues of [[2,1],[1,2]] as 3 and 1", () => {
		const { values } = jacobiEigen([
			[2, 1],
			[1, 2],
		]);
		near(values[0]!, 3);
		near(values[1]!, 1);
	});

	it("returns orthonormal eigenvectors that satisfy A·v = λ·v on a 3×3 case", () => {
		const A = [
			[4, 1, 0.5],
			[1, 3, 0.25],
			[0.5, 0.25, 1],
		];
		const { values, vectors } = jacobiEigen(A);
		assert.ok(values[0]! >= values[1]! && values[1]! >= values[2]!, "sorted descending");
		near(
			values.reduce((s, v) => s + v, 0),
			8,
		); // trace is preserved
		for (let e = 0; e < 3; e++) {
			const v = vectors[e]!;
			near(
				v.reduce((s, x) => s + x * x, 0),
				1,
			);
			for (let i = 0; i < 3; i++) {
				const av = A[i]!.reduce((s, a, j) => s + a * v[j]!, 0);
				near(av, values[e]! * v[i]!, 1e-9);
			}
		}
		near(
			vectors[0]!.reduce((s, x, i) => s + x * vectors[1]![i]!, 0),
			0,
		);
	});

	it("handles an already diagonal matrix and sorts it", () => {
		const { values } = jacobiEigen([
			[1, 0, 0],
			[0, 5, 0],
			[0, 0, 3],
		]);
		assert.deepEqual(values, [5, 3, 1]);
	});
});

describe("world anchors: classicalMds", () => {
	it("reproduces the pairwise distances of points on a plane (2D stress ≈ 0)", () => {
		const pts = [
			[0, 0],
			[3, 0],
			[3, 4],
			[-2, 5],
			[1, -2],
			[6, 2],
		];
		const D = pts.map((p) => pts.map((q) => Math.hypot(p[0]! - q[0]!, p[1]! - q[1]!)));
		const { coords } = classicalMds(D, 2);
		assert.equal(coords.length, 6);
		assert.equal(coords[0]!.length, 2);
		assert.ok(embeddingStress(D, coords) < 1e-6);
	});

	it("needs a third dimension for points in space", () => {
		const pts = [
			[0, 0, 0],
			[1, 0, 0],
			[0, 1, 0],
			[0, 0, 1],
			[1, 1, 1],
		];
		const D = pts.map((p) => pts.map((q) => Math.hypot(p[0]! - q[0]!, p[1]! - q[1]!, p[2]! - q[2]!)));
		assert.ok(embeddingStress(D, classicalMds(D, 3).coords) < 1e-6);
		assert.ok(embeddingStress(D, classicalMds(D, 2).coords) > 0.01);
	});

	it("is sign-stable: the largest component of each axis is positive", () => {
		const D = [
			[0, 1, 2],
			[1, 0, 1.5],
			[2, 1.5, 0],
		];
		const { coords } = classicalMds(D, 2);
		for (let k = 0; k < 2; k++) {
			const col = coords.map((r) => r[k]!);
			const big = col.reduce((m, x) => (Math.abs(x) > Math.abs(m) ? x : m), 0);
			assert.ok(big >= 0);
		}
	});
});

describe("world anchors: overlap distance", () => {
	it("weights a topic shared by k degrees at 1/(k−1)", () => {
		// a,b exclusively share 2 topics (k=2 → weight 1 each); a topic in all four
		// degrees (k=4 → weight 1/3) adds a little more; each degree has 2 own topics.
		const t = [
			...topics(2, ["a", "b"]),
			...topics(1, ["a", "b", "c", "d"]),
			...topics(2, ["a"]),
			...topics(2, ["b"]),
			...topics(2, ["c"]),
			...topics(2, ["d"]),
		];
		const D = degreeDistances(t, ["a", "b", "c", "d"]);
		// |Ta| = |Tb| = 5; shared(a,b) = 2·1 + 1/3
		near(D[0]![1]!, 1 - (2 + 1 / 3) / 5);
		// a,c share only the 4-way topic: shared = 1/3; |Ta| = 5, |Tc| = 3
		near(D[0]![2]!, 1 - 1 / 3 / 3);
		near(D[0]![0]!, 0);
		near(D[1]![0]!, D[0]![1]!); // symmetric
	});

	it("a topic in every degree barely counts", () => {
		const base = [...topics(5, ["a"]), ...topics(5, ["b"]), ...topics(5, ["c"])];
		const everywhere = topics(1, ["a", "b", "c"]); // k=3 → w=1/2
		const calc = topics(1, ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m"]); // w=1/12
		const ids = ["a", "b", "c"];
		const d0 = degreeDistances(base, ids)[0]![1]!;
		const d1 = degreeDistances([...base, ...calc], ids)[0]![1]!;
		const d2 = degreeDistances([...base, ...everywhere], ids)[0]![1]!;
		assert.ok(d1 < d0 && d2 < d1 && d0 - d1 < 0.02);
	});

	it("clamps similarity into [0,1]", () => {
		const D = degreeDistances(topics(3, ["a", "b"]), ["a", "b"]);
		near(D[0]![1]!, 0);
	});
});

describe("world anchors: fitSimilarity", () => {
	const target: WorldPosition[] = [
		{ x: 0, y: 0 },
		{ x: 1000, y: 200 },
		{ x: 400, y: 900 },
		{ x: -300, y: 500 },
	];
	const fromRotated = (theta: number, scale: number, reflect: boolean, tx: number, ty: number): WorldPosition[] =>
		target.map((p) => {
			const y0 = reflect ? -p.y : p.y;
			return {
				x: scale * (Math.cos(theta) * p.x - Math.sin(theta) * y0) + tx,
				y: scale * (Math.sin(theta) * p.x + Math.cos(theta) * y0) + ty,
			};
		});

	it("recovers a rotation, scale and translation exactly", () => {
		const from = fromRotated(0.7, 0.003, false, 5, -2);
		const fit = fitSimilarity(from, target);
		for (let i = 0; i < from.length; i++) assert.ok(dist(fit.apply(from[i]!), target[i]!) < 1e-6);
		near(fit.residual, 0, 1e-6);
		assert.equal(fit.reflected, false);
	});

	it("recovers a reflection too", () => {
		const from = fromRotated(-1.2, 2.5, true, 40, 70);
		const fit = fitSimilarity(from, target);
		for (let i = 0; i < from.length; i++) assert.ok(dist(fit.apply(from[i]!), target[i]!) < 1e-6);
		assert.equal(fit.reflected, true);
	});

	it("derived anchors land on the fallback when the geometry already matches", () => {
		// MDS of the fallback's own distances, fed through the same alignment.
		const ids = Object.keys(SQUARE);
		const D = ids.map((p) => ids.map((q) => dist(SQUARE[p]!, SQUARE[q]!)));
		const { coords } = classicalMds(D, 2);
		const from = coords.map((c) => ({ x: c[0]!, y: c[1]! }));
		const fit = fitSimilarity(
			from,
			ids.map((i) => SQUARE[i]!),
		);
		ids.forEach((id, i) => assert.ok(dist(fit.apply(from[i]!), SQUARE[id]!) < 1e-6, id));
	});
});

describe("world anchors: deriveDegreeAnchors", () => {
	it("puts heavily overlapping degrees closer than degrees with no overlap", () => {
		const out = deriveDegreeAnchors(twoPairs(), SQUARE);
		assert.deepEqual(out.derived, ["a", "b", "c", "d"]);
		assert.deepEqual(out.kept, []);
		const { anchors } = out;
		assert.ok(dist(anchors.a!, anchors.b!) < dist(anchors.a!, anchors.c!));
		assert.ok(dist(anchors.a!, anchors.b!) < dist(anchors.a!, anchors.d!));
		assert.ok(dist(anchors.c!, anchors.d!) < dist(anchors.b!, anchors.c!));
		// the hand-drawn map had a-b as far apart as a-c; the data pulled them together
		assert.ok(dist(anchors.a!, anchors.b!) < dist(SQUARE.a!, SQUARE.b!));
	});

	it("keeps degrees under minTopics, or absent, at their exact fallback anchor", () => {
		const fallback = { ...SQUARE, e: { x: 5, y: 6 }, f: { x: 7, y: 8 } };
		const t = [...twoPairs(), ...topics(4, ["e"])]; // e has 4 < 5; f has none
		const out = deriveDegreeAnchors(t, fallback);
		assert.deepEqual(out.kept, ["e", "f"]);
		assert.deepEqual(out.derived, ["a", "b", "c", "d"]);
		assert.deepEqual(out.anchors.e, { x: 5, y: 6 });
		assert.deepEqual(out.anchors.f, { x: 7, y: 8 });
		const loose = deriveDegreeAnchors(t, fallback, { minTopics: 4 });
		assert.deepEqual(loose.derived, ["a", "b", "c", "d", "e"]);
		assert.deepEqual(loose.kept, ["f"]);
	});

	it("returns the fallback unchanged with null stress when fewer than 3 degrees qualify", () => {
		const t = [...topics(8, ["a", "b"]), ...topics(1, ["c"])];
		const out = deriveDegreeAnchors(t, SQUARE);
		assert.deepEqual(out.anchors, SQUARE);
		assert.deepEqual(out.derived, []);
		assert.deepEqual(out.kept, ["a", "b", "c", "d"]);
		assert.equal(out.stress, null);
	});

	it("is deterministic, and its keys are exactly the fallback keys", () => {
		const fallback = { ...SQUARE, e: { x: 5, y: 6 } };
		const one = deriveDegreeAnchors(twoPairs(), fallback);
		const two = deriveDegreeAnchors(twoPairs(), fallback);
		assert.deepEqual(one, two);
		assert.deepEqual(Object.keys(one.anchors).sort(), Object.keys(fallback).sort());
		for (const p of Object.values(one.anchors)) assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
	});

	it("ignores topic degrees that are not in the fallback", () => {
		const t = [...twoPairs(), ...topics(9, ["zzz"])];
		const out = deriveDegreeAnchors(t, SQUARE);
		assert.deepEqual(Object.keys(out.anchors).sort(), ["a", "b", "c", "d"]);
	});

	it("reports 3D stress no worse than 2D stress", () => {
		const t = [
			...topics(6, ["a", "b"]),
			...topics(6, ["b", "c"]),
			...topics(6, ["c", "d"]),
			...topics(6, ["a", "d"]),
			...topics(6, ["a", "c"]),
			...topics(6, ["b", "d"]),
		];
		const out = deriveDegreeAnchors(t, SQUARE);
		assert.ok(out.stress);
		assert.ok(out.stress.d3 <= out.stress.d2 + 1e-9);
		assert.ok(out.stress.d2 >= 0 && out.stress.d2 <= 1);
	});

	it("does not mutate its inputs", () => {
		const t = twoPairs();
		const before = JSON.stringify([t, SQUARE]);
		deriveDegreeAnchors(t, SQUARE);
		assert.equal(JSON.stringify([t, SQUARE]), before);
	});
});
