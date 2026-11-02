/**
 * World anchors (core/world-anchors.ts) — degree anchors derived from topic
 * overlap by classical MDS on a log-similarity distance, aligned to the
 * hand-drawn map. Properties: the Jacobi eigen routine and MDS are exact on
 * known inputs, a topic shared by k degrees weighs 1/(k−1), distance is
 * −ln(similarity), SMACOF refinement keeps close neighbours close and never
 * raises weighted stress, heavily overlapping degrees end up close, the derived map
 * keeps the hand-drawn map's spread and a minimum separation, degrees with
 * too little data keep their fallback, and the result is deterministic.
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
	matchSpread,
	separateAnchors,
	smacof,
	weightedStress,
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
		// |Ta| = |Tb| = 5; shared(a,b) = 2·1 + 1/3; distance = −ln(similarity)
		near(D[0]![1]!, -Math.log((2 + 1 / 3) / 5));
		// a,c share only the 4-way topic: shared = 1/3; |Ta| = 5, |Tc| = 3
		near(D[0]![2]!, -Math.log(1 / 3 / 3));
		near(D[0]![0]!, 0);
		near(D[1]![0]!, D[0]![1]!); // symmetric
	});

	it("a topic in every degree barely counts", () => {
		// a and b share two topics of their own; one more shared topic is added, taught by
		// just a and b (w=1), by three degrees (w=1/2) or by thirteen (w=1/12, "calculus").
		const base = [...topics(5, ["a"]), ...topics(5, ["b"]), ...topics(5, ["c"]), ...topics(2, ["a", "b"])];
		const three = topics(1, ["a", "b", "c"]);
		const calc = topics(1, ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m"]);
		const ids = ["a", "b", "c"];
		const d0 = degreeDistances(base, ids)[0]![1]!;
		const dOnly = degreeDistances([...base, ...topics(1, ["a", "b"])], ids)[0]![1]!;
		const dThree = degreeDistances([...base, ...three], ids)[0]![1]!;
		const dCalc = degreeDistances([...base, ...calc], ids)[0]![1]!;
		assert.ok(dOnly < d0, "an exclusive shared topic brings them closer");
		assert.ok(dOnly < dThree && dThree < dCalc, "the more degrees teach it, the less it counts");
		assert.ok(Math.abs(dCalc - d0) < 0.15, "calculus barely moves them");
	});

	it("clamps similarity into [0,1]: identical degrees are at distance 0", () => {
		const D = degreeDistances(topics(3, ["a", "b"]), ["a", "b"]);
		near(D[0]![1]!, 0);
	});

	it("floors similarity at 1e-3, so degrees sharing nothing are at distance ln(1000), not infinity", () => {
		const D = degreeDistances([...topics(5, ["a"]), ...topics(5, ["b"])], ["a", "b"]);
		near(D[0]![1]!, Math.log(1000));
		near(D[1]![0]!, Math.log(1000));
	});

	it("keeps the order of the neighbours but stretches small similarities apart", () => {
		// a–b share 1 of 50 topics (s = 0.02), a–c share 3 of 50 (s = 0.06): the old
		// 1 − s put them 0.04 apart; −ln s puts them ln 3 ≈ 1.1 apart.
		const t = [
			...topics(1, ["a", "b"]),
			...topics(3, ["a", "c"]),
			...topics(46, ["a"]),
			...topics(49, ["b"]),
			...topics(47, ["c"]),
		];
		const D = degreeDistances(t, ["a", "b", "c"]);
		assert.ok(D[0]![2]! < D[0]![1]!);
		near(D[0]![1]! - D[0]![2]!, Math.log(3));
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

const rms = (ps: readonly WorldPosition[]): number => {
	const cx = ps.reduce((s, p) => s + p.x, 0) / ps.length;
	const cy = ps.reduce((s, p) => s + p.y, 0) / ps.length;
	return Math.sqrt(ps.reduce((s, p) => s + (p.x - cx) ** 2 + (p.y - cy) ** 2, 0) / ps.length);
};
const minPair = (ps: readonly WorldPosition[]): number => {
	let m = Infinity;
	for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) m = Math.min(m, dist(ps[i]!, ps[j]!));
	return m;
};

/** A deterministic, non-Euclidean distance matrix: partners (2i, 2i+1) at 0.5, everyone else far. */
function partnered(pairs: number, far = 5): number[][] {
	const n = pairs * 2;
	return Array.from({ length: n }, (_, i) =>
		Array.from({ length: n }, (__, j) => (i === j ? 0 : i >> 1 === j >> 1 ? 0.5 : far + ((i * 7 + j * 7) % 5) * 0.1)),
	);
}

describe("world anchors: smacof", () => {
	const noisy = partnered(5);
	for (const power of [0, 1, 2]) {
		it(`never increases weighted stress compared with its classical-MDS seed (weight power ${power})`, () => {
			const seed = classicalMds(noisy, 2).coords;
			const out = smacof(noisy, seed, { weightPower: power });
			assert.ok(weightedStress(noisy, out, power) <= weightedStress(noisy, seed, power) + 1e-9);
			assert.ok(weightedStress(noisy, out, power) < weightedStress(noisy, seed, power), "and strictly improves here");
		});
	}

	it("strictly lowers weighted stress below its classical-MDS seed on a non-planar fixture", () => {
		// Corners of a unit-ish box plus an off-centre point: genuinely 3D, so no 2D
		// embedding is exact and the classical seed is not already optimal.
		const pts = [
			[0, 0, 0],
			[4, 0, 0],
			[0, 2, 0],
			[4, 2, 0],
			[0, 0, 1],
			[4, 0, 1],
			[0, 2, 1],
			[4, 2, 1],
			[1, 1, 3],
		];
		const D = pts.map((p) => pts.map((q) => Math.hypot(p[0]! - q[0]!, p[1]! - q[1]!, p[2]! - q[2]!)));
		const mds = classicalMds(D, 2);
		assert.ok(mds.eigenvalues[2]! > 1e-6, "a third positive eigenvalue: not embeddable in the plane");
		const out = smacof(D, mds.coords);
		for (const power of [0, 1, 2]) {
			const before = weightedStress(D, mds.coords, power);
			const after = weightedStress(D, smacof(D, mds.coords, { weightPower: power }), power);
			assert.ok(after < before, `power ${power}: ${after} < ${before}`);
		}
		assert.ok(weightedStress(D, out) < weightedStress(D, mds.coords));
	});

	it("recovers a planar configuration from a perturbed start (stress ≈ 0)", () => {
		const pts = [
			[0, 0],
			[3, 0],
			[3, 4],
			[-2, 5],
			[1, -2],
			[6, 2],
			[2, 2],
		];
		const D = pts.map((p) => pts.map((q) => Math.hypot(p[0]! - q[0]!, p[1]! - q[1]!)));
		const start = pts.map((p, i) => [p[0]! + Math.sin(i * 2.1) * 1.5, p[1]! + Math.cos(i * 1.3) * 1.5]);
		const out = smacof(D, start);
		assert.ok(embeddingStress(D, out) < 1e-3, `stress ${embeddingStress(D, out)}`);
	});

	it("is deterministic and does not mutate its seed", () => {
		const seed = classicalMds(noisy, 2).coords;
		const before = JSON.stringify(seed);
		assert.deepEqual(smacof(noisy, seed), smacof(noisy, seed));
		assert.equal(JSON.stringify(seed), before);
	});

	it("keeps each point's nearest neighbour when the seed already has it", () => {
		for (const k of [2, 3]) {
			const out = smacof(noisy, classicalMds(noisy, k).coords);
			for (let i = 0; i < noisy.length; i++) {
				let best = -1;
				let bd = Infinity;
				for (let j = 0; j < noisy.length; j++) {
					if (j === i) continue;
					const d = Math.hypot(...out[i]!.map((x, a) => x - out[j]![a]!));
					if (d < bd) [best, bd] = [j, d];
				}
				assert.equal(best, i ^ 1, `point ${i} in ${k}D`);
			}
		}
	});

	it("handles coincident seed points and a single point", () => {
		const D = [
			[0, 1, 1],
			[1, 0, 1],
			[1, 1, 0],
		];
		const out = smacof(D, [
			[0, 0],
			[0, 0],
			[0, 0],
		]);
		assert.ok(out.flat().every(Number.isFinite));
		assert.deepEqual(smacof([[0]], [[1, 2]]), [[1, 2]]);
	});
});

describe("world anchors: matchSpread", () => {
	it("rescales about the centroid so the RMS distance from it is the target", () => {
		const pts = [
			{ x: 0, y: 0 },
			{ x: 10, y: 0 },
			{ x: 10, y: 10 },
			{ x: 0, y: 10 },
		];
		const out = matchSpread(pts, 100);
		near(rms(out), 100);
		near((out[0]!.x + out[2]!.x) / 2, 5); // centroid unmoved
		near((out[0]!.y + out[2]!.y) / 2, 5);
		near(dist(out[0]!, out[1]!), dist(out[1]!, out[2]!)); // shape unchanged
	});

	it("leaves points that are all in one spot where they are", () => {
		const pts = [
			{ x: 3, y: 4 },
			{ x: 3, y: 4 },
		];
		assert.deepEqual(matchSpread(pts, 50), pts);
	});
});

describe("world anchors: separateAnchors", () => {
	it("pushes two anchors that are too close apart along their own line, symmetrically", () => {
		const out = separateAnchors(
			[
				{ x: 0, y: 0 },
				{ x: 10, y: 0 },
			],
			[false, false],
			100,
		);
		near(dist(out[0]!, out[1]!), 100, 1e-6);
		near(out[0]!.y, 0);
		near((out[0]!.x + out[1]!.x) / 2, 5); // midpoint unmoved
	});

	it("separates coincident anchors deterministically", () => {
		const pts = [
			{ x: 5, y: 5 },
			{ x: 5, y: 5 },
			{ x: 5, y: 5 },
		];
		const one = separateAnchors(pts, [false, false, false], 10);
		assert.deepEqual(one, separateAnchors(pts, [false, false, false], 10));
		assert.ok(minPair(one) >= 10 - 1e-6);
	});

	it("never moves a fixed anchor, and leaves already separated anchors alone", () => {
		const out = separateAnchors(
			[
				{ x: 0, y: 0 },
				{ x: 10, y: 0 },
				{ x: 500, y: 500 },
			],
			[true, false, false],
			100,
		);
		assert.deepEqual(out[0], { x: 0, y: 0 });
		near(dist(out[0]!, out[1]!), 100, 1e-6);
		assert.deepEqual(out[2], { x: 500, y: 500 });
	});

	it("does not mutate its input", () => {
		const pts = [
			{ x: 0, y: 0 },
			{ x: 1, y: 0 },
		];
		separateAnchors(pts, [false, false], 100);
		assert.deepEqual(pts, [
			{ x: 0, y: 0 },
			{ x: 1, y: 0 },
		]);
	});
});

const RING_IDS = ["a", "b", "c", "d", "e", "f"];
/** Six degrees on a hexagon; neighbours on the ring share 6 topics, others 1. */
function ring(): { fallback: Record<string, WorldPosition>; t: WorldTopic[] } {
	const fallback = Object.fromEntries(
		RING_IDS.map((d, i) => [
			d,
			{ x: 50000 + 20000 * Math.cos((i * Math.PI) / 3), y: 30000 + 20000 * Math.sin((i * Math.PI) / 3) },
		]),
	);
	const t: WorldTopic[] = RING_IDS.flatMap((d) => topics(40, [d]));
	for (let i = 0; i < 6; i++) {
		for (let j = i + 1; j < 6; j++) {
			const adjacent = j - i === 1 || j - i === 5;
			t.push(...topics(adjacent ? 6 : 1, [RING_IDS[i]!, RING_IDS[j]!]));
		}
	}
	return { fallback, t };
}

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
		assert.equal(out.minSeparation, null);
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

	it("keeps the hand-drawn map's spread: derived RMS spread equals the hand RMS spread", () => {
		const { fallback, t } = ring();
		const out = deriveDegreeAnchors(t, fallback);
		assert.deepEqual(out.derived, RING_IDS);
		near(rms(RING_IDS.map((d) => out.anchors[d]!)), rms(RING_IDS.map((d) => fallback[d]!)), 1e-6);
	});

	it("measures the hand spread over the derived degrees only", () => {
		const { fallback, t } = ring();
		const far = { ...fallback, z: { x: 900000, y: -900000 } }; // kept: no topics
		const out = deriveDegreeAnchors(t, far);
		assert.deepEqual(out.kept, ["z"]);
		near(rms(RING_IDS.map((d) => out.anchors[d]!)), rms(RING_IDS.map((d) => fallback[d]!)), 1e-6);
		assert.deepEqual(out.anchors.z, { x: 900000, y: -900000 });
	});

	it("holds a minimum separation of 0.6 x the median nearest-neighbour distance of the hand anchors", () => {
		// Hand anchors 1000 apart on a square: minimum separation 600.
		const out = deriveDegreeAnchors(twoPairs(), SQUARE);
		assert.ok(out.minSeparation !== null);
		near(out.minSeparation, 600);
		assert.ok(minPair(Object.values(out.anchors)) >= 600 - 1e-6);

		// Three degrees that overlap almost totally would land nearly on top of each
		// other; the separation pass keeps them apart.
		const fallback = {
			a: { x: 0, y: 0 },
			b: { x: 1000, y: 0 },
			c: { x: 0, y: 1000 },
			x: { x: 1000, y: 1000 },
		};
		const t = [
			...topics(20, ["a", "b", "c"]),
			...topics(1, ["a"]),
			...topics(1, ["b"]),
			...topics(1, ["c"]),
			...topics(20, ["x"]),
		];
		const tight = deriveDegreeAnchors(t, fallback);
		assert.deepEqual(tight.derived, ["a", "b", "c", "x"]);
		assert.ok(minPair(Object.values(tight.anchors)) >= 600 - 1e-6);
	});

	it("never moves a kept anchor to satisfy the separation, and keeps clear of it", () => {
		// e is kept (3 topics) but sits right where derived degrees land.
		const fallback = { ...SQUARE, e: { x: 500, y: 500 } };
		const out = deriveDegreeAnchors([...twoPairs(), ...topics(3, ["e"])], fallback);
		assert.deepEqual(out.kept, ["e"]);
		assert.deepEqual(out.anchors.e, { x: 500, y: 500 });
		for (const d of out.derived) assert.ok(dist(out.anchors[d]!, out.anchors.e!) >= out.minSeparation! - 1e-6, d);
	});

	it("does not collapse the anchors when every similarity is tiny and nearly equal", () => {
		// Six degrees with 40 own topics each; every pair shares one topic, a–b two.
		// Similarities are 0.025–0.05: with distance 1 − s that is a uniform 0.95–0.975,
		// MDS is mostly noise and a least-squares fit shrinks the map to a blob.
		const ids = ["a", "b", "c", "d", "e", "f"];
		const hex = Object.fromEntries(
			ids.map((d, i) => [
				d,
				{ x: 50000 + 20000 * Math.cos((i * Math.PI) / 3), y: 30000 + 20000 * Math.sin((i * Math.PI) / 3) },
			]),
		);
		const t: WorldTopic[] = ids.flatMap((d) => topics(40, [d]));
		for (let i = 0; i < ids.length; i++) {
			for (let j = i + 1; j < ids.length; j++) t.push(...topics(1, [ids[i]!, ids[j]!]));
		}
		t.push(...topics(1, ["a", "b"]));
		const out = deriveDegreeAnchors(t, hex);
		assert.deepEqual(out.derived, ids);
		const handRms = rms(ids.map((d) => hex[d]!));
		const derivedRms = rms(ids.map((d) => out.anchors[d]!));
		assert.ok(Math.abs(derivedRms - handRms) / handRms < 0.05, `spread ${derivedRms} vs ${handRms}`);
		assert.ok(minPair(ids.map((d) => out.anchors[d]!)) >= out.minSeparation! - 1e-6);
		assert.ok(out.minSeparation! >= 0.6 * 20000 - 1e-6); // hexagon side = radius = 20000
	});

	it("keeps each degree's most-overlapping partner as its nearest anchor", () => {
		// Four partner pairs (8 topics shared); every other pair shares one topic.
		const ids = ["a", "b", "c", "d", "e", "f", "g", "h"];
		const fallback = Object.fromEntries(
			ids.map((d, i) => [d, { x: 40000 + 30000 * Math.cos(i * 0.9), y: 30000 + 20000 * Math.sin(i * 0.9) }]),
		);
		const t: WorldTopic[] = ids.flatMap((d) => topics(30, [d]));
		for (let i = 0; i < 8; i++) {
			for (let j = i + 1; j < 8; j++) t.push(...topics(i >> 1 === j >> 1 ? 8 : 1, [ids[i]!, ids[j]!]));
		}
		const out = deriveDegreeAnchors(t, fallback);
		assert.deepEqual(out.derived, ids);
		ids.forEach((d, i) => {
			const others = ids.filter((e) => e !== d).sort((x, y) => dist(out.anchors[d]!, out.anchors[x]!) - dist(out.anchors[d]!, out.anchors[y]!));
			assert.equal(others[0], ids[i ^ 1], `nearest of ${d}`);
		});
	});

	it("does not mutate its inputs", () => {
		const t = twoPairs();
		const before = JSON.stringify([t, SQUARE]);
		deriveDegreeAnchors(t, SQUARE);
		assert.equal(JSON.stringify([t, SQUARE]), before);
	});
});
