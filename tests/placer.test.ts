/**
 * The placer (forest): a background stage that assigns every graph
 * proposition to one topic of the fixed world, appending to the world
 * store's placements ledger. Scripted faux engines drive the model;
 * the graph and world stores are in-memory.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type FauxResponseStep, type ToolCall } from "@earendil-works/pi-ai";
import type { PiEngine } from "../src/agent/models.ts";
import type { GraphChain, GraphNode } from "../src/core/contracts.ts";
import type { Placement, WorldFile, WorldTopic } from "../src/core/contracts/world.ts";
import type { WorldStore } from "../src/core/ports.ts";
import type { ExtractionPipeline } from "../src/agent/subagents/extraction.ts";
import { EXTRACTION_CORE } from "../src/agent/subagents/extraction.ts";
import { createPlacer, withPlacement } from "../src/agent/subagents/placer.ts";

// ─── fixtures ────────────────────────────────────────────────────────────────

const topic = (id: string, name: string, scope: string): WorldTopic => ({
	id,
	name,
	scope,
	degrees: ["physics"],
	courses: [],
	prereqs: [],
});

const THERMO = topic("thermodynamics", "Thermodynamics", "Heat, entropy, energy and the laws of thermodynamics.");
const LINALG = topic("linear-algebra", "Linear algebra", "Vector spaces, matrices and eigenvalues.");

const worldFile = (topics: WorldTopic[]): WorldFile => ({ version: 1, generatedAt: "2026-01-01T00:00:00.000Z", degrees: [], topics });

function memoryWorld(world: WorldFile | null): WorldStore & { lines: Placement[] } {
	const lines: Placement[] = [];
	return {
		lines,
		readWorld: () => world,
		writeWorld: () => undefined,
		appendPlacement: (p) => void lines.push({ ...p }),
		readPlacements: () => lines.map((p) => ({ ...p })),
	};
}

const node = (id: string, name: string, statement: string): GraphNode => ({
	id,
	name,
	statement,
	aliases: [],
	createdAt: "2026-01-01T00:00:00.000Z",
	provenance: [],
});

function memoryGraph(nodes: GraphNode[]) {
	const chains: GraphChain[] = [];
	return { readNodes: () => nodes.map((n) => ({ ...n })), readChains: () => chains };
}

function fauxEngine(steps: FauxResponseStep[]): PiEngine {
	const faux = createFauxCore({});
	faux.setResponses(steps);
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}

/** One scripted submit_placements turn; reports every model call. */
function submitStep(payload: unknown, onCall?: () => void): FauxResponseStep {
	return () => {
		onCall?.();
		return fauxAssistantMessage(
			[fauxToolCall("submit_placements", payload as ToolCall["arguments"], { id: "placements-call" })],
			{ stopReason: "toolUse" },
		);
	};
}

const placements = (...pairs: Array<[string, string | null]>) => ({
	placements: pairs.map(([nodeId, topicId]) => ({ nodeId, topicId })),
});

const THREE = [
	node("n_a", "Entropy", "The entropy of an isolated system never decreases."),
	node("n_b", "Eigenvalue", "An eigenvalue of a matrix scales its eigenvector."),
	node("n_c", "Heat flow", "Heat flows from hot bodies to cold bodies."),
];

/** Stub console.warn for one test; returns the captured calls and a restore. */
function captureWarn() {
	const original = console.warn;
	const calls: unknown[][] = [];
	console.warn = (...args: unknown[]) => void calls.push(args);
	return { calls, restore: () => void (console.warn = original) };
}

// ─── tests ───────────────────────────────────────────────────────────────────

describe("placer", () => {
	it("places what is unplaced, and a second call makes no model call", async () => {
		const world = memoryWorld(worldFile([THERMO, LINALG]));
		let calls = 0;
		const engine = fauxEngine([
			submitStep(placements(["n_a", "thermodynamics"], ["n_b", "linear-algebra"], ["n_c", null]), () => calls++),
		]);
		const placer = createPlacer({
			graphStore: memoryGraph(THREE),
			worldStore: world,
			engineFor: () => engine,
			now: () => "2026-02-02T00:00:00.000Z",
		});
		const stats = await placer.placeUnplaced();
		assert.deepEqual(stats, { placed: 2, uncharted: 1, skipped: 0 });
		assert.equal(world.lines.length, 3);
		assert.deepEqual(world.lines.find((l) => l.nodeId === "n_c"), {
			nodeId: "n_c",
			topicId: null,
			placedAt: "2026-02-02T00:00:00.000Z",
		});
		assert.equal(calls, 1);

		const again = await placer.placeUnplaced();
		assert.deepEqual(again, { placed: 0, uncharted: 0, skipped: 0 });
		assert.equal(calls, 1);
		assert.equal(world.lines.length, 3);
	});

	it("rejects a topic outside the offered candidates, the model resubmits, one placement per node", async () => {
		const world = memoryWorld(worldFile([THERMO, LINALG]));
		let calls = 0;
		const engine = fauxEngine([
			// n_a's only candidate is thermodynamics — linear-algebra is outside the offer.
			submitStep(placements(["n_a", "linear-algebra"], ["n_b", "linear-algebra"], ["n_c", "thermodynamics"]), () => calls++),
			submitStep(placements(["n_a", "thermodynamics"], ["n_b", "linear-algebra"], ["n_c", "thermodynamics"]), () => calls++),
		]);
		const placer = createPlacer({ graphStore: memoryGraph(THREE), worldStore: world, engineFor: () => engine });
		const stats = await placer.placeUnplaced();
		assert.equal(calls, 2);
		assert.deepEqual(stats, { placed: 3, uncharted: 0, skipped: 0 });
		assert.equal(world.lines.length, 3);
		assert.equal(world.lines.find((l) => l.nodeId === "n_a")?.topicId, "thermodynamics");
	});

	it("rejects a submit that omits a batch node", async () => {
		const world = memoryWorld(worldFile([THERMO, LINALG]));
		let calls = 0;
		const engine = fauxEngine([
			submitStep(placements(["n_a", "thermodynamics"], ["n_b", "linear-algebra"]), () => calls++),
			submitStep(placements(["n_a", "thermodynamics"], ["n_b", "linear-algebra"], ["n_c", null]), () => calls++),
		]);
		const placer = createPlacer({ graphStore: memoryGraph(THREE), worldStore: world, engineFor: () => engine });
		const stats = await placer.placeUnplaced();
		assert.equal(calls, 2);
		assert.deepEqual(stats, { placed: 2, uncharted: 1, skipped: 0 });
		assert.equal(world.lines.length, 3);
	});

	it("batches 45 unplaced nodes into 3 submits of at most 20", async () => {
		const world = memoryWorld(worldFile([THERMO, LINALG]));
		const nodes = Array.from({ length: 45 }, (_, i) =>
			node(`n_${String(i).padStart(3, "0")}`, `Entropy ${i}`, "Entropy in a thermodynamics setting."),
		);
		const ids = nodes.map((n) => n.id).sort();
		const sizes: number[] = [];
		const steps = [ids.slice(0, 20), ids.slice(20, 40), ids.slice(40)].map((batch) =>
			submitStep(placements(...batch.map((id): [string, string] => [id, "thermodynamics"])), () => sizes.push(batch.length)),
		);
		const placer = createPlacer({ graphStore: memoryGraph(nodes), worldStore: world, engineFor: () => fauxEngine(steps) });
		const stats = await placer.placeUnplaced();
		assert.deepEqual(sizes, [20, 20, 5]);
		assert.deepEqual(stats, { placed: 45, uncharted: 0, skipped: 0 });
		assert.equal(world.lines.length, 45);
	});

	it("a node with no candidates is placed null without a model call", async () => {
		const world = memoryWorld(worldFile([THERMO]));
		let calls = 0;
		const placer = createPlacer({
			graphStore: memoryGraph([node("n_z", "Zzz", "Qux quux corge.")]),
			worldStore: world,
			engineFor: () => fauxEngine([submitStep(placements(), () => calls++)]),
		});
		const stats = await placer.placeUnplaced();
		assert.deepEqual(stats, { placed: 0, uncharted: 1, skipped: 0 });
		assert.equal(calls, 0);
		assert.equal(world.lines[0]?.topicId, null);
	});

	it("a batch that never submits is skipped and the later batches still place", async () => {
		const warn = captureWarn();
		try {
			const world = memoryWorld(worldFile([THERMO, LINALG]));
			const nodes = Array.from({ length: 60 }, (_, i) =>
				node(`n_${String(i).padStart(3, "0")}`, `Entropy ${i}`, "Entropy in a thermodynamics setting."),
			);
			const ids = nodes.map((n) => n.id).sort();
			const middle = new Set(ids.slice(20, 40));
			// Answers by reading the batch out of the prompt: the middle batch
			// only ever submits an unoffered topic, so it never validates.
			const step: FauxResponseStep = (context) => {
				const batch = [...JSON.stringify(context.messages).matchAll(/PROPOSITION (n_\d+)/g)].map((m) => m[1] as string);
				const bad = middle.has(batch[0] as string);
				return fauxAssistantMessage(
					[
						fauxToolCall(
							"submit_placements",
							placements(...batch.map((id): [string, string] => [id, bad ? "no-such-topic" : "thermodynamics"])) as ToolCall["arguments"],
							{ id: "placements-call" },
						),
					],
					{ stopReason: "toolUse" },
				);
			};
			const placer = createPlacer({
				graphStore: memoryGraph(nodes),
				worldStore: world,
				engineFor: () => fauxEngine(Array.from({ length: 12 }, () => step)),
			});
			const stats = await placer.placeUnplaced();
			assert.deepEqual(stats, { placed: 40, uncharted: 0, skipped: 20 });
			assert.equal(world.lines.length, 40);
			assert.ok(world.lines.every((l) => !middle.has(l.nodeId)));
			assert.equal(warn.calls.length, 1);
			assert.match(String(warn.calls[0]?.[0]), new RegExp(ids[20] as string));
		} finally {
			warn.restore();
		}
	});

	it("no world yet: skipped, no model call", async () => {
		const world = memoryWorld(null);
		let calls = 0;
		const placer = createPlacer({
			graphStore: memoryGraph(THREE),
			worldStore: world,
			engineFor: () => fauxEngine([submitStep(placements(), () => calls++)]),
		});
		assert.deepEqual(await placer.placeUnplaced(), { placed: 0, uncharted: 0, skipped: 3 });
		assert.equal(calls, 0);
		assert.equal(world.lines.length, 0);
	});

	it("no model configured: same as no world", async () => {
		const world = memoryWorld(worldFile([THERMO, LINALG]));
		const placer = createPlacer({ graphStore: memoryGraph(THREE), worldStore: world, engineFor: () => undefined });
		assert.deepEqual(await placer.placeUnplaced(), { placed: 0, uncharted: 0, skipped: 3 });
		assert.equal(world.lines.length, 0);
	});
});

describe("withPlacement", () => {
	const stats = { nodesAdded: 1 } as never;
	const fakePlacer = () => {
		let n = 0;
		return {
			get calls() {
				return n;
			},
			placeUnplaced: async () => {
				n++;
				return { placed: 0, uncharted: 0, skipped: 0 };
			},
		};
	};

	it("calls placeUnplaced once after runExtraction (and importNotes) resolves", async () => {
		const placer = fakePlacer();
		const pipeline: ExtractionPipeline = {
			runExtraction: async () => stats,
			importNotes: async () => stats,
		};
		const wrapped = withPlacement(pipeline, placer);
		assert.equal(await wrapped.runExtraction("chat"), stats);
		assert.equal(placer.calls, 1);
		assert.equal(await wrapped.importNotes({} as never), stats);
		assert.equal(placer.calls, 2);
	});

	it("does not place when runExtraction rejects, and the rejection propagates", async () => {
		const placer = fakePlacer();
		const pipeline: ExtractionPipeline = {
			runExtraction: async () => {
				throw new Error("boom");
			},
			importNotes: async () => stats,
		};
		await assert.rejects(withPlacement(pipeline, placer).runExtraction("chat"), /boom/);
		assert.equal(placer.calls, 0);
	});

	it("a failing placer never fails the extraction", async () => {
		const pipeline: ExtractionPipeline = { runExtraction: async () => stats, importNotes: async () => stats };
		const warn = captureWarn();
		try {
			const wrapped = withPlacement(pipeline, {
				placeUnplaced: async () => {
					throw new Error("placer down");
				},
			});
			assert.equal(await wrapped.runExtraction("chat"), stats);
			await new Promise((resolve) => setImmediate(resolve));
			assert.equal(warn.calls.length, 1);
		} finally {
			warn.restore();
		}
	});
});

describe("general-form propositions", () => {
	it("EXTRACTION_CORE tells the extractor to state propositions in general form", () => {
		assert.ok(
			EXTRACTION_CORE.includes(
				"State every proposition in general form, independent of any project or application it was taught for.",
			),
		);
	});
});
