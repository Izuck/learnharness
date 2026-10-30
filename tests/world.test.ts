// WORLD PURE CORE — pinned behaviors:
// 1. SLUGS: topicSlug is the identity key for topics across degrees.
// 2. MERGE: batches from many degrees/courses collapse into one deterministic,
//    id-sorted topic list; prereq names resolve through topicSlug, unresolved
//    ones are reported (never silently kept), and no topic is its own prereq.
// 3. PLACEMENTS: latest placedAt wins per node, dead nodes are ignored, null
//    ("no topic fits") is a real placement.
// 4. CANDIDATES: word-stem overlap ranking, name hits double, ties by id.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
	CourseTopicsBatch,
	Placement,
	WorldTopic,
} from "../src/core/contracts/world.ts";
import {
	isCourseTopicsBatch,
	isWorldFile,
	mergeDegreeTopics,
	mergePlacements,
	topicCandidates,
	topicSlug,
	unplacedNodeIds,
} from "../src/core/world.ts";

describe("world: topicSlug", () => {
	it("lowercases, trims and hyphenates", () => {
		assert.equal(topicSlug("Linear Algebra "), "linear-algebra");
	});
	it("drops ampersands and other punctuation", () => {
		assert.equal(topicSlug("Fourier analysis & PDEs"), "fourier-analysis-pdes");
	});
});

describe("world: mergeDegreeTopics", () => {
	const batches: CourseTopicsBatch[] = [
		{
			degree: "math",
			course: "Linear Algebra I",
			topics: [{ name: "Linear Algebra", scope: "vector spaces", prereqs: [] }],
		},
		{
			degree: "physics",
			course: "Mathematical Methods",
			topics: [
				{ name: "linear algebra", scope: "matrices", prereqs: ["Nonexistent Topic"] },
				{
					name: "Quantum States",
					scope: "kets",
					prereqs: ["Linear  Algebra", "Quantum States"],
				},
			],
		},
	];

	it("merges same-slug topics across degrees and courses", () => {
		const { topics } = mergeDegreeTopics(batches);
		const la = topics.filter((t) => t.id === "linear-algebra");
		assert.equal(la.length, 1);
		assert.deepEqual(la[0]?.degrees, ["math", "physics"]);
		assert.deepEqual(la[0]?.courses, ["Linear Algebra I", "Mathematical Methods"]);
	});

	it("resolves prereqs by slug, drops unresolved ones and self-references", () => {
		const { topics, unresolvedPrereqs } = mergeDegreeTopics(batches);
		const qs = topics.find((t) => t.id === "quantum-states");
		assert.deepEqual(qs?.prereqs, ["linear-algebra"]);
		const la = topics.find((t) => t.id === "linear-algebra");
		assert.deepEqual(la?.prereqs, []);
		assert.deepEqual(unresolvedPrereqs, [
			{ topic: "linear-algebra", prereq: "Nonexistent Topic" },
		]);
	});

	it("is sorted by id and deterministic regardless of input order", () => {
		const a = mergeDegreeTopics(batches);
		const b = mergeDegreeTopics([...batches].reverse());
		assert.deepEqual(a.topics.map((t) => t.id), ["linear-algebra", "quantum-states"]);
		assert.equal(JSON.stringify(a.topics), JSON.stringify(b.topics));
	});

	it("deduplicates degrees and courses", () => {
		const { topics } = mergeDegreeTopics([
			{ degree: "math", course: "C1", topics: [{ name: "X", scope: "s", prereqs: [] }] },
			{ degree: "math", course: "C1", topics: [{ name: "x", scope: "s", prereqs: [] }] },
		]);
		assert.deepEqual(topics[0]?.degrees, ["math"]);
		assert.deepEqual(topics[0]?.courses, ["C1"]);
	});
});

describe("world: guards", () => {
	it("isCourseTopicsBatch accepts a valid batch", () => {
		assert.equal(
			isCourseTopicsBatch({
				degree: "d",
				course: "c",
				topics: [{ name: "n", scope: "s", prereqs: ["p"] }],
			}),
			true,
		);
	});
	it("isCourseTopicsBatch rejects a missing topics array", () => {
		assert.equal(isCourseTopicsBatch({ degree: "d", course: "c" }), false);
	});
	it("isCourseTopicsBatch rejects a topic without a string scope", () => {
		assert.equal(
			isCourseTopicsBatch({
				degree: "d",
				course: "c",
				topics: [{ name: "n", prereqs: [] }],
			}),
			false,
		);
	});
	it("isCourseTopicsBatch rejects non-array prereqs", () => {
		assert.equal(
			isCourseTopicsBatch({
				degree: "d",
				course: "c",
				topics: [{ name: "n", scope: "s", prereqs: "p" }],
			}),
			false,
		);
	});
	it("isWorldFile accepts a valid file and rejects a wrong version", () => {
		const ok = {
			version: 1,
			generatedAt: "2026-10-30T00:00:00.000Z",
			degrees: [{ id: "math", name: "Mathematics" }],
			topics: [
				{ id: "a", name: "A", scope: "s", degrees: ["math"], courses: ["c"], prereqs: [] },
			],
		};
		assert.equal(isWorldFile(ok), true);
		assert.equal(isWorldFile({ ...ok, version: 2 }), false);
		assert.equal(isWorldFile(null), false);
		assert.equal(isWorldFile({ ...ok, topics: [{ id: "a" }] }), false);
	});
});

describe("world: placements", () => {
	const live = new Set(["a", "b", "c"]);
	const line = (nodeId: string, topicId: string | null, placedAt: string): Placement => ({
		nodeId,
		topicId,
		placedAt,
	});

	it("later placedAt wins per node, regardless of line order", () => {
		const m = mergePlacements(
			[line("a", "t2", "2026-10-02"), line("a", "t1", "2026-10-01")],
			live,
		);
		assert.equal(m.get("a"), "t2");
	});
	it("ignores lines for nodes that are not live", () => {
		const m = mergePlacements([line("dead", "t1", "2026-10-01")], live);
		assert.equal(m.has("dead"), false);
	});
	it("keeps a null topicId as null", () => {
		const m = mergePlacements([line("b", null, "2026-10-01")], live);
		assert.equal(m.has("b"), true);
		assert.equal(m.get("b"), null);
	});
	it("unplacedNodeIds treats null placements as placed", () => {
		const merged = new Map<string, string | null>([
			["a", "t1"],
			["b", null],
		]);
		assert.deepEqual(unplacedNodeIds(["a", "b", "c"], merged), ["c"]);
	});
});

describe("world: topicCandidates", () => {
	const mk = (id: string, name: string, scope: string): WorldTopic => ({
		id,
		name,
		scope,
		degrees: [],
		courses: [],
		prereqs: [],
	});
	const topics = [
		mk("fourier-series", "Fourier series", "periodic functions as sums of sines"),
		mk(
			"gaussian-quadrature",
			"Gaussian quadrature",
			"nodes chosen so the rule is exact for polynomials of degree up to 2n-1",
		),
		mk("trapezoid-rule", "Trapezoid rule", "piecewise linear numerical integration"),
	];

	it("ranks the best overlap first", () => {
		const r = topicCandidates("Gauss quadrature exactness degree 2n-1", topics, 2);
		assert.equal(r[0]?.id, "gaussian-quadrature");
	});
	it("returns at most k topics", () => {
		const r = topicCandidates("quadrature polynomials integration series", topics, 2);
		assert.ok(r.length <= 2);
	});
	it("never returns zero-overlap topics", () => {
		const r = topicCandidates("quadrature", topics, 10);
		assert.deepEqual(r.map((t) => t.id), ["gaussian-quadrature"]);
		assert.deepEqual(topicCandidates("zebra", topics, 5), []);
	});
	it("breaks ties by id", () => {
		const tied = [mk("b-topic", "Alpha", ""), mk("a-topic", "Alpha", "")];
		const r = topicCandidates("alpha", tied, 2);
		assert.deepEqual(r.map((t) => t.id), ["a-topic", "b-topic"]);
	});
});
