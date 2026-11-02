/**
 * World anchors — degree anchors derived from the generated topics.
 *
 * Degrees that teach many of the same topics should sit close on the world
 * map. The overlap of every pair of degrees becomes a distance (−ln of the
 * similarity), classical multidimensional scaling (MDS) embeds those
 * distances, and a least-squares similarity transform fits the embedding onto
 * the hand-drawn anchors, which fixes its orientation, reflection and
 * position. The fit's scale is then replaced: real similarities are small and
 * bunched, the embedding is noisy, and a least-squares scale shrinks a poor
 * fit toward the centroid, so the derived anchors are rescaled to have the
 * hand-drawn anchors' RMS spread instead. A last pass pushes apart any two
 * anchors that still sit closer than a minimum separation. The stress of the
 * 2D and 3D embeddings says how much a flat map distorts the overlap
 * structure, and whether a third dimension would help.
 *
 * PURE and DETERMINISTIC: no randomness, no clock, no I/O; degrees are always
 * visited in sorted id order.
 */

import type { WorldPosition, WorldTopic } from "./contracts/world.ts";

export interface DerivedAnchors {
	/** Every key of the fallback, and nothing else. */
	anchors: Record<string, WorldPosition>;
	/** Degree ids placed from data, sorted. */
	derived: string[];
	/** Degree ids that kept their fallback anchor, sorted. */
	kept: string[];
	/** Normalised stress of the 2D and 3D embeddings (0 = perfect, 1 = useless);
	 *  null when nothing was derived. */
	stress: { d2: number; d3: number } | null;
	/** The minimum distance enforced between any two anchors (world units);
	 *  null when nothing was derived. */
	minSeparation: number | null;
}

/** Default minimum number of topics a degree needs before its anchor is derived. */
const MIN_TOPICS = 5;
/** A degree needs at least this many qualifying degrees to be worth an embedding. */
const MIN_CANDIDATES = 3;
/**
 * Similarity floor for the distance transform, δ = −ln(max(s, ε)). It only
 * guards degrees that share nothing (s = 0 → δ = ∞); on the real world the
 * smallest pair similarity is 0.006, so the floor never binds there. 1e-3 caps
 * δ at ln 1000 ≈ 6.9, a little above the largest real distance (≈ 5.1), so a
 * pair with no overlap at all is farther than any pair with some.
 */
const MIN_SIMILARITY = 1e-3;
/** Minimum anchor separation as a fraction of the hand-drawn anchors' median
 *  nearest-neighbour distance. On the approved map the median is 13,830 and the
 *  closest pair (cs–compe) is 9,220, i.e. 0.67 x the median, so 0.6 (8,298)
 *  lets derived neighbours sit a little closer than the closest hand-drawn
 *  pair, but never on top of each other. */
const MIN_SEPARATION_FACTOR = 0.6;
const SEPARATION_MAX_PASSES = 500;
const JACOBI_MAX_SWEEPS = 100;
const EPS = 1e-12;

const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Eigendecomposition of a symmetric matrix by cyclic Jacobi rotations.
 * Returns the eigenvalues in descending order; `vectors[i]` is the unit
 * eigenvector of `values[i]`. The input is not mutated.
 */
export function jacobiEigen(matrix: readonly (readonly number[])[]): { values: number[]; vectors: number[][] } {
	const n = matrix.length;
	const A = matrix.map((r) => [...r]);
	const V = A.map((_, i) => A.map((__, j): number => (i === j ? 1 : 0)));

	for (let sweep = 0; sweep < JACOBI_MAX_SWEEPS; sweep++) {
		let off = 0;
		let diag = 0;
		for (let i = 0; i < n; i++) {
			diag += A[i]![i]! * A[i]![i]!;
			for (let j = i + 1; j < n; j++) off += A[i]![j]! * A[i]![j]!;
		}
		if (off <= 1e-30 * Math.max(diag, 1e-300) || off === 0) break;

		for (let p = 0; p < n - 1; p++) {
			for (let q = p + 1; q < n; q++) {
				const apq = A[p]![q]!;
				if (Math.abs(apq) < 1e-300) continue;
				const theta = (A[q]![q]! - A[p]![p]!) / (2 * apq);
				const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
				const c = 1 / Math.sqrt(t * t + 1);
				const s = t * c;
				for (let k = 0; k < n; k++) {
					const akp = A[k]![p]!;
					const akq = A[k]![q]!;
					A[k]![p] = c * akp - s * akq;
					A[k]![q] = s * akp + c * akq;
				}
				for (let k = 0; k < n; k++) {
					const apk = A[p]![k]!;
					const aqk = A[q]![k]!;
					A[p]![k] = c * apk - s * aqk;
					A[q]![k] = s * apk + c * aqk;
				}
				for (let k = 0; k < n; k++) {
					const vkp = V[k]![p]!;
					const vkq = V[k]![q]!;
					V[k]![p] = c * vkp - s * vkq;
					V[k]![q] = s * vkp + c * vkq;
				}
			}
		}
	}

	const order = A.map((_, i) => i).sort((i, j) => A[j]![j]! - A[i]![i]! || i - j);
	return {
		values: order.map((i) => A[i]![i]!),
		vectors: order.map((i) => V.map((row) => row[i]!)),
	};
}

/**
 * Classical MDS of a symmetric distance matrix into `k` dimensions. Returns
 * `coords[i]` (length k) per point, plus all eigenvalues of the double-centred
 * matrix (descending). Each axis has a deterministic sign (its largest-
 * magnitude entry is positive); a non-positive eigenvalue gives a zero axis.
 */
export function classicalMds(
	dist: readonly (readonly number[])[],
	k: number,
): { coords: number[][]; eigenvalues: number[] } {
	const n = dist.length;
	const sq = dist.map((row) => row.map((d) => d * d));
	const rowMean = sq.map((row) => row.reduce((s, x) => s + x, 0) / n);
	const grand = rowMean.reduce((s, x) => s + x, 0) / n;
	const B = sq.map((row, i) => row.map((x, j) => -0.5 * (x - rowMean[i]! - rowMean[j]! + grand)));

	const { values, vectors } = jacobiEigen(B);
	const coords = Array.from({ length: n }, () => new Array<number>(k).fill(0));
	for (let axis = 0; axis < k && axis < n; axis++) {
		const v = vectors[axis]!;
		let big = 0;
		for (const x of v) if (Math.abs(x) > Math.abs(big) + 1e-12) big = x;
		const sign = big < 0 ? -1 : 1;
		const scale = Math.sqrt(Math.max(values[axis]!, 0));
		for (let i = 0; i < n; i++) coords[i]![axis] = sign * v[i]! * scale;
	}
	return { coords, eigenvalues: values };
}

/**
 * Normalised stress between target distances and an embedding:
 * √(Σ(δ − c·e)² / Σδ²) over pairs i<j, with the optimal scale c = Σδe / Σe².
 * 1 when the embedding is degenerate (Σe² = 0).
 */
export function embeddingStress(
	dist: readonly (readonly number[])[],
	coords: readonly (readonly number[])[],
): number {
	const n = dist.length;
	let de = 0;
	let ee = 0;
	let dd = 0;
	const e: number[][] = [];
	for (let i = 0; i < n; i++) {
		e.push([]);
		for (let j = i + 1; j < n; j++) {
			let s = 0;
			for (let a = 0; a < coords[i]!.length; a++) s += (coords[i]![a]! - coords[j]![a]!) ** 2;
			const d = dist[i]![j]!;
			const m = Math.sqrt(s);
			e[i]!.push(m);
			de += d * m;
			ee += m * m;
			dd += d * d;
		}
	}
	if (ee <= EPS || dd <= EPS) return 1;
	const c = de / ee;
	let num = 0;
	for (let i = 0; i < n; i++) {
		for (let j = i + 1; j < n; j++) num += (dist[i]![j]! - c * e[i]![j - i - 1]!) ** 2;
	}
	return Math.sqrt(num / dd);
}

/**
 * Pairwise degree distance from topic overlap. A topic taught by k ≥ 2
 * degrees weighs 1/(k−1), so a topic shared by two degrees counts fully and
 * calculus shared by thirteen barely counts. similarity s(a,b) = Σw over the
 * topics both teach / min(|Tₐ|, |T_b|), clamped to [0,1]; distance δ =
 * −ln(max(s, 1e-3)), and δ(a,a) = 0. `k` is the topic's full number of
 * degrees, not just those in `ids`.
 *
 * Why −ln and not 1 − s: real similarities are tiny and compressed (0.006 to
 * 0.24, median 0.03), so 1 − s is almost uniform (0.76 to 0.99) and MDS on it
 * is mostly noise. The log is monotone, so the neighbour order is unchanged,
 * but it spreads the small similarities out (0.006 → 5.1, 0.03 → 3.5, 0.24 →
 * 1.4) and turns "twice as similar" into a constant distance gap.
 */
export function degreeDistances(topics: readonly WorldTopic[], ids: readonly string[]): number[][] {
	const index = new Map(ids.map((id, i) => [id, i]));
	const n = ids.length;
	const size = new Array<number>(n).fill(0);
	const shared = Array.from({ length: n }, () => new Array<number>(n).fill(0));
	for (const t of topics) {
		const all = new Set(t.degrees);
		const mine = [...all].filter((d) => index.has(d)).map((d) => index.get(d)!);
		for (const i of mine) size[i]!++;
		if (all.size < 2) continue;
		const w = 1 / (all.size - 1);
		for (const i of mine) for (const j of mine) if (i !== j) shared[i]![j]! += w;
	}
	return shared.map((row, i) =>
		row.map((s, j) => {
			if (i === j) return 0;
			const denom = Math.min(size[i]!, size[j]!);
			const sim = denom > 0 ? Math.min(1, Math.max(0, s / denom)) : 0;
			return -Math.log(Math.max(sim, MIN_SIMILARITY)) || 0; // || 0 turns −0 into 0
		}),
	);
}

export interface SimilarityFit {
	scale: number;
	/** True when the best fit mirrors the points (y → −y before rotating). */
	reflected: boolean;
	/** Sum of squared distances left between the mapped points and the targets. */
	residual: number;
	apply: (p: WorldPosition) => WorldPosition;
}

/**
 * Least-squares similarity transform (uniform scale, rotation OR reflection,
 * translation) taking `from` onto `to`. Both the proper rotation and the
 * reflection are fitted in closed form (complex-number Procrustes) and the
 * one with the lower residual wins; a tie goes to the rotation.
 */
export function fitSimilarity(from: readonly WorldPosition[], to: readonly WorldPosition[]): SimilarityFit {
	const n = from.length;
	const mean = (ps: readonly WorldPosition[]): WorldPosition => ({
		x: ps.reduce((s, p) => s + p.x, 0) / n,
		y: ps.reduce((s, p) => s + p.y, 0) / n,
	});
	const fm = mean(from);
	const tm = mean(to);

	const fit = (reflected: boolean): SimilarityFit => {
		const sy = reflected ? -1 : 1;
		let a = 0;
		let b = 0;
		let norm = 0;
		for (let i = 0; i < n; i++) {
			const fx = from[i]!.x - fm.x;
			const fy = sy * (from[i]!.y - fm.y);
			const tx = to[i]!.x - tm.x;
			const ty = to[i]!.y - tm.y;
			a += fx * tx + fy * ty;
			b += fx * ty - fy * tx;
			norm += fx * fx + fy * fy;
		}
		const scale = norm > EPS ? Math.hypot(a, b) / norm : 0;
		const theta = Math.atan2(b, a);
		const cos = Math.cos(theta);
		const sin = Math.sin(theta);
		const apply = (p: WorldPosition): WorldPosition => {
			const x = p.x - fm.x;
			const y = sy * (p.y - fm.y);
			return { x: scale * (cos * x - sin * y) + tm.x, y: scale * (sin * x + cos * y) + tm.y };
		};
		let residual = 0;
		for (let i = 0; i < n; i++) {
			const m = apply(from[i]!);
			residual += (m.x - to[i]!.x) ** 2 + (m.y - to[i]!.y) ** 2;
		}
		return { scale, reflected, residual, apply };
	};

	const rotation = fit(false);
	const reflection = fit(true);
	return reflection.residual < rotation.residual ? reflection : rotation;
}

/**
 * Rescale `points` about their centroid so their RMS distance from it is
 * `targetRms`. Points that all coincide are returned as they are.
 */
export function matchSpread(points: readonly WorldPosition[], targetRms: number): WorldPosition[] {
	const n = points.length;
	if (n === 0) return [];
	const cx = points.reduce((s, p) => s + p.x, 0) / n;
	const cy = points.reduce((s, p) => s + p.y, 0) / n;
	const current = Math.sqrt(points.reduce((s, p) => s + (p.x - cx) ** 2 + (p.y - cy) ** 2, 0) / n);
	if (current <= EPS) return points.map((p) => ({ ...p }));
	const k = targetRms / current;
	return points.map((p) => ({ x: cx + (p.x - cx) * k, y: cy + (p.y - cy) * k }));
}

/**
 * Push apart any two points closer than `minDist`, in deterministic passes
 * over index pairs (i<j) until none is, or SEPARATION_MAX_PASSES. A violating
 * pair moves symmetrically along its own line to exactly `minDist`; if one of
 * the two is `fixed` the other takes the whole move; two fixed points are
 * left alone. Coincident points separate along a direction set by their
 * indices. The input is not mutated.
 */
export function separateAnchors(
	points: readonly WorldPosition[],
	fixed: readonly boolean[],
	minDist: number,
): WorldPosition[] {
	const out = points.map((p) => ({ ...p }));
	const n = out.length;
	for (let pass = 0; pass < SEPARATION_MAX_PASSES; pass++) {
		let moved = false;
		for (let i = 0; i < n - 1; i++) {
			for (let j = i + 1; j < n; j++) {
				if (fixed[i] && fixed[j]) continue;
				const p = out[i]!;
				const q = out[j]!;
				const dx = q.x - p.x;
				const dy = q.y - p.y;
				const d = Math.hypot(dx, dy);
				if (d >= minDist * (1 - 1e-9)) continue;
				let ux: number;
				let uy: number;
				if (d <= EPS) {
					const angle = (2 * Math.PI * (j - i)) / n;
					ux = Math.cos(angle);
					uy = Math.sin(angle);
				} else {
					ux = dx / d;
					uy = dy / d;
				}
				const need = minDist - d;
				const toP = fixed[i] ? 0 : fixed[j] ? need : need / 2;
				const toQ = need - toP;
				p.x -= ux * toP;
				p.y -= uy * toP;
				q.x += ux * toQ;
				q.y += uy * toQ;
				moved = true;
			}
		}
		if (!moved) break;
	}
	return out;
}

/** RMS distance of the points from their centroid. */
function rmsSpread(points: readonly WorldPosition[]): number {
	const n = points.length;
	const cx = points.reduce((s, p) => s + p.x, 0) / n;
	const cy = points.reduce((s, p) => s + p.y, 0) / n;
	return Math.sqrt(points.reduce((s, p) => s + (p.x - cx) ** 2 + (p.y - cy) ** 2, 0) / n);
}

/** Median over the points of the distance to the nearest other point. */
function medianNearest(points: readonly WorldPosition[]): number {
	const nearest = points.map((p, i) =>
		Math.min(...points.filter((_, j) => j !== i).map((q) => Math.hypot(p.x - q.x, p.y - q.y))),
	);
	nearest.sort((a, b) => a - b);
	const m = nearest.length >> 1;
	return nearest.length % 2 ? nearest[m]! : (nearest[m - 1]! + nearest[m]!) / 2;
}

/**
 * Derive degree anchors from topic overlap. Degrees (keys of `fallback`) with
 * at least `minTopics` topics (default 5) are placed from data; the rest keep
 * their fallback anchor. With fewer than three such degrees, or an overlap
 * structure with no spread at all, nothing is derived and the fallback is
 * returned unchanged.
 *
 * Placement: the 2D MDS of the log-similarity distances is fitted to the
 * hand-drawn anchors of the derived degrees (rotation or reflection and
 * translation come from the least-squares fit), then rescaled about its
 * centroid to the hand anchors' RMS spread, then relaxed so no two anchors
 * are closer than MIN_SEPARATION_FACTOR x the median nearest-neighbour
 * distance of those hand anchors. Kept degrees stay exactly where they are
 * and count as fixed obstacles in that last step.
 */
export function deriveDegreeAnchors(
	topics: readonly WorldTopic[],
	fallback: Readonly<Record<string, WorldPosition>>,
	opts: { minTopics?: number } = {},
): DerivedAnchors {
	const minTopics = opts.minTopics ?? MIN_TOPICS;
	const all = Object.keys(fallback).sort(byId);
	const count = new Map<string, number>();
	for (const t of topics) for (const d of new Set(t.degrees)) count.set(d, (count.get(d) ?? 0) + 1);

	const candidates = all.filter((d) => (count.get(d) ?? 0) >= minTopics);
	const unchanged = (): DerivedAnchors => ({
		anchors: Object.fromEntries(all.map((d) => [d, { ...fallback[d]! }])),
		derived: [],
		kept: all,
		stress: null,
		minSeparation: null,
	});
	if (candidates.length < MIN_CANDIDATES) return unchanged();

	const D = degreeDistances(topics, candidates);
	const mds2 = classicalMds(D, 2);
	const stress = { d2: embeddingStress(D, mds2.coords), d3: embeddingStress(D, classicalMds(D, 3).coords) };
	const flat = mds2.coords.map((c) => ({ x: c[0]!, y: c[1]! }));
	if (flat.every((p) => Math.hypot(p.x - flat[0]!.x, p.y - flat[0]!.y) <= EPS)) return unchanged();

	const hand = candidates.map((d) => fallback[d]!);
	const fit = fitSimilarity(flat, hand);
	const spread = matchSpread(
		flat.map((p) => fit.apply(p)),
		rmsSpread(hand),
	);

	// Separate derived anchors from each other and from the kept ones.
	const keptIds = all.filter((d) => !candidates.includes(d));
	const minSeparation = MIN_SEPARATION_FACTOR * medianNearest(hand);
	const separated = separateAnchors(
		[...spread, ...keptIds.map((d) => fallback[d]!)],
		[...spread.map(() => false), ...keptIds.map(() => true)],
		minSeparation,
	);
	const placed = new Map(candidates.map((d, i) => [d, separated[i]!]));
	return {
		anchors: Object.fromEntries(all.map((d) => [d, placed.get(d) ?? { ...fallback[d]! }])),
		derived: candidates,
		kept: keptIds,
		stress,
		minSeparation,
	};
}
