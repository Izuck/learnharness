// FOREST MODEL — pinned behaviors:
// 1. LIGHTING: an idea placed on a positioned topic lights it (ideas, counts,
//    glow); an unplaced topic stays fogged (glow 0, no ideas).
// 2. UNCHARTED: ideas placed null, or on a topic that is missing or has no
//    position, are collected sorted; dead nodes' placements change nothing;
//    live nodes with no decision yet are "unplaced".
// 3. TRAILS: derived from chains between distinct placed topics, one count per
//    chain per pair; crossDegree when the two topics share no degree.
// 4. REGIONS: the centroid of each degree's positioned topics.
// 5. COVERAGE: topics with an idea / positioned topics; formatCoverage and
//    topicGlow are exact.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GraphChain, GraphNode } from "../src/core/contracts/graph.ts";
import type { Placement, WorldFile, WorldTopic } from "../src/core/contracts/world.ts";
import { buildForest, formatCoverage, topicGlow } from "../src/core/forest.ts";

const topic = (
	id: string,
	degrees: string[],
	position?: { x: number; y: number },
): WorldTopic => ({
	id,
	name: id.toUpperCase(),
	scope: `${id} scope`,
	degrees,
	courses: [],
	prereqs: [],
	...(position ? { position } : {}),
});

const world: WorldFile = {
	version: 1,
	generatedAt: "2026-11-02T00:00:00.000Z",
	degrees: [
		{ id: "math", name: "Maths (world)" },
		{ id: "physics", name: "Physics (world)" },
	],
	topics: [
		topic("t1", ["math"], { x: 0, y: 0 }),
		topic("t2", ["math"], { x: 10, y: 20 }),
		topic("t3", ["physics"], { x: 100, y: 100 }),
		topic("t4", ["math", "physics"], { x: 50, y: 60 }),
		topic("tx", ["math"]),
	],
};

const node = (id: string): GraphNode => ({
	id,
	name: id,
	statement: `${id} holds`,
	aliases: [],
	createdAt: "2026-11-02T00:00:00.000Z",
	provenance: [],
});

const chain = (id: string, premises: string[], conclusion: string): GraphChain => ({
	id,
	premises,
	conclusion,
	provenance: [],
	createdAt: "2026-11-02T00:00:00.000Z",
});

const place = (nodeId: string, topicId: string | null, placedAt = "2026-11-02T01:00:00.000Z"): Placement => ({
	nodeId,
	topicId,
	placedAt,
});

const nodes = (...ids: string[]) => ids.map(node);
const empty = { propositions: [] as GraphNode[], chains: [] as GraphChain[] };

describe("forest: buildForest — lighting", () => {
	it("places ideas on their topic and lights it", () => {
		const f = buildForest(world, [place("n2", "t1"), place("n1", "t1")], {
			propositions: nodes("n1", "n2"),
			chains: [],
		});
		const t1 = f.topics.find((t) => t.id === "t1")!;
		assert.deepEqual(t1.ideas, ["n1", "n2"]);
		assert.deepEqual(t1.counts, { seen: 2, held: 0, fast: 0 });
		assert.ok(t1.glow > 0);
		const t2 = f.topics.find((t) => t.id === "t2")!;
		assert.equal(t2.glow, 0);
		assert.deepEqual(t2.ideas, []);
		assert.deepEqual(t2.counts, { seen: 0, held: 0, fast: 0 });
	});

	it("carries the topic's identity and position", () => {
		const f = buildForest(world, [], empty);
		const t2 = f.topics.find((t) => t.id === "t2")!;
		assert.equal(t2.name, "T2");
		assert.equal(t2.scope, "t2 scope");
		assert.deepEqual(t2.degrees, ["math"]);
		assert.equal(t2.x, 10);
		assert.equal(t2.y, 20);
	});

	it("stateOf drives counts", () => {
		const f = buildForest(
			world,
			[place("n1", "t1"), place("n2", "t1")],
			{ propositions: nodes("n1", "n2"), chains: [] },
			(id) => (id === "n2" ? "fast" : "seen"),
		);
		const t1 = f.topics.find((t) => t.id === "t1")!;
		assert.deepEqual(t1.counts, { seen: 1, held: 0, fast: 1 });
	});

	it("keeps topics in world order, positioned ones only", () => {
		const f = buildForest(world, [], empty);
		assert.deepEqual(f.topics.map((t) => t.id), ["t1", "t2", "t3", "t4"]);
	});

	it("takes the latest placement per node", () => {
		const f = buildForest(
			world,
			[place("n1", "t1", "2026-11-02T01:00:00.000Z"), place("n1", "t2", "2026-11-02T02:00:00.000Z")],
			{ propositions: nodes("n1"), chains: [] },
		);
		assert.deepEqual(f.topics.find((t) => t.id === "t1")!.ideas, []);
		assert.deepEqual(f.topics.find((t) => t.id === "t2")!.ideas, ["n1"]);
	});
});

describe("forest: buildForest — uncharted, unplaced, unpositioned", () => {
	it("uncharted collects null, unknown and unpositioned topics", () => {
		const f = buildForest(
			world,
			[place("n4", null), place("n3", "no-such-topic"), place("n1", "tx"), place("n2", "t1")],
			{ propositions: nodes("n1", "n2", "n3", "n4"), chains: [] },
		);
		assert.deepEqual(f.uncharted, ["n1", "n3", "n4"]);
		assert.deepEqual(f.topics.find((t) => t.id === "t1")!.ideas, ["n2"]);
		assert.equal(f.unplaced, 0);
	});

	it("ignores placements of deleted nodes", () => {
		const f = buildForest(
			world,
			[place("ghost", "t1"), place("ghost2", null)],
			{ propositions: nodes("n1"), chains: [] },
		);
		assert.deepEqual(f.topics.find((t) => t.id === "t1")!.ideas, []);
		assert.deepEqual(f.uncharted, []);
		assert.equal(f.unplaced, 1);
	});

	it("counts undecided live nodes as unplaced", () => {
		const f = buildForest(world, [], { propositions: nodes("n1"), chains: [] });
		assert.equal(f.unplaced, 1);
		assert.deepEqual(f.uncharted, []);
	});

	it("counts topics without positions", () => {
		const f = buildForest(world, [], empty);
		assert.equal(f.unpositioned, 1);
		assert.ok(!f.topics.some((t) => t.id === "tx"));
	});
});

describe("forest: buildForest — trails", () => {
	const placed = [
		place("n1", "t1"),
		place("n2", "t1"),
		place("n3", "t2"),
		place("n4", "t3"),
		place("n5", "t4"),
	];
	const props = nodes("n1", "n2", "n3", "n4", "n5", "n6", "n7");

	it("derives trails between distinct placed topics", () => {
		const one = buildForest(world, placed, {
			propositions: props,
			chains: [chain("arg_1", ["n1", "n2"], "n3")],
		});
		assert.deepEqual(one.trails, [{ a: "t1", b: "t2", chains: 1, crossDegree: false }]);
		const two = buildForest(world, placed, {
			propositions: props,
			chains: [chain("arg_1", ["n1", "n2"], "n3"), chain("arg_2", ["n3"], "n2")],
		});
		assert.deepEqual(two.trails, [{ a: "t1", b: "t2", chains: 2, crossDegree: false }]);
	});

	it("orders a before b whichever way the argument runs", () => {
		const f = buildForest(world, placed, {
			propositions: props,
			chains: [chain("arg_1", ["n3"], "n1")],
		});
		assert.deepEqual(f.trails.map((t) => [t.a, t.b]), [["t1", "t2"]]);
	});

	it("marks crossDegree when the topics share no degree", () => {
		const f = buildForest(world, placed, {
			propositions: props,
			chains: [chain("arg_1", ["n1"], "n4"), chain("arg_2", ["n5"], "n1")],
		});
		assert.deepEqual(f.trails, [
			{ a: "t1", b: "t3", chains: 1, crossDegree: true },
			{ a: "t1", b: "t4", chains: 1, crossDegree: false },
		]);
	});

	it("sorts trails by (a, b)", () => {
		const f = buildForest(world, placed, {
			propositions: props,
			chains: [chain("arg_1", ["n4"], "n3"), chain("arg_2", ["n2"], "n4"), chain("arg_3", ["n1"], "n3")],
		});
		assert.deepEqual(f.trails.map((t) => `${t.a}-${t.b}`), ["t1-t2", "t1-t3", "t2-t3"]);
	});

	it("makes no trail from uncharted or unplaced members, nor within one topic", () => {
		const f = buildForest(
			world,
			[...placed, place("n6", null)],
			{
				propositions: props, // n7 has no placement at all
				chains: [
					chain("arg_1", ["n1"], "n2"), // within t1
					chain("arg_2", ["n1"], "n6"), // uncharted
					chain("arg_3", ["n1"], "n7"), // unplaced
					chain("arg_4", ["n1"], "ghost"), // deleted
				],
			},
		);
		assert.deepEqual(f.trails, []);
	});
});

describe("forest: buildForest — regions and coverage", () => {
	it("regions sit at the centroid of their degree's topics", () => {
		const f = buildForest(world, [], empty);
		const math = f.regions.find((r) => r.degreeId === "math")!;
		// positioned math topics: t1 (0,0), t2 (10,20), t4 (50,60)
		assert.equal(math.x, 20);
		assert.equal(math.y, (0 + 20 + 60) / 3);
		assert.equal(math.name, "Maths (world)");
		const physics = f.regions.find((r) => r.degreeId === "physics")!;
		assert.equal(physics.x, (100 + 50) / 2);
		assert.equal(physics.y, (100 + 60) / 2);
	});

	it("names a region from WORLD_DEGREES when the world lacks the degree", () => {
		const w: WorldFile = {
			...world,
			degrees: [],
			topics: [topic("t1", ["chemistry"], { x: 4, y: 8 })],
		};
		const f = buildForest(w, [], empty);
		assert.deepEqual(f.regions, [{ degreeId: "chemistry", name: "Chemistry", x: 4, y: 8 }]);
	});

	it("a degree with no positioned topic has no region", () => {
		const w: WorldFile = {
			...world,
			degrees: [...world.degrees, { id: "ee", name: "Electrical Engineering" }],
			topics: [...world.topics, topic("t5", ["ee"])],
		};
		const f = buildForest(w, [], empty);
		assert.ok(!f.regions.some((r) => r.degreeId === "ee"));
	});

	it("coverage counts topics with at least one idea", () => {
		const f = buildForest(world, [place("n1", "t1"), place("n2", "t1")], {
			propositions: nodes("n1", "n2"),
			chains: [],
		});
		assert.deepEqual(f.coverage, { mapped: 1, total: 4 });
	});
});

describe("forest: buildForest — determinism", () => {
	it("two calls on the same input are deepEqual", () => {
		const input = [place("n1", "t1"), place("n3", "t2"), place("n2", null)];
		const graph = {
			propositions: nodes("n1", "n2", "n3"),
			chains: [chain("arg_1", ["n1"], "n3")],
		};
		assert.deepEqual(buildForest(world, input, graph), buildForest(world, input, graph));
	});
});

describe("forest: formatCoverage", () => {
	it("formats percentages with just enough precision", () => {
		assert.equal(formatCoverage(0, 4), "0%");
		assert.equal(formatCoverage(1, 5000), "0.02%");
		assert.equal(formatCoverage(7, 10000), "0.07%");
		assert.equal(formatCoverage(17, 500), "3.4%");
		assert.equal(formatCoverage(1, 4), "25%");
		assert.equal(formatCoverage(4, 4), "100%");
		assert.equal(formatCoverage(0, 0), "0%");
	});

	it("falls to the first non-zero digit below 0.005%", () => {
		assert.equal(formatCoverage(1, 50000), "0.002%");
		assert.equal(formatCoverage(1, 250000), "0.0004%");
	});

	it("strips a trailing .0", () => {
		assert.equal(formatCoverage(1, 10), "10%");
		assert.equal(formatCoverage(3, 100), "3%");
	});
});

describe("forest: topicGlow", () => {
	it("is 0 with no ideas, 0.475 all seen, 1 all fast", () => {
		assert.equal(topicGlow({ seen: 0, held: 0, fast: 0 }), 0);
		assert.equal(topicGlow({ seen: 3, held: 0, fast: 0 }), 0.475);
		assert.equal(topicGlow({ seen: 0, held: 0, fast: 5 }), 1);
	});

	it("is monotonic seen < held < fast for one idea", () => {
		const s = topicGlow({ seen: 1, held: 0, fast: 0 });
		const h = topicGlow({ seen: 0, held: 1, fast: 0 });
		const f = topicGlow({ seen: 0, held: 0, fast: 1 });
		assert.ok(s < h && h < f);
	});
});
