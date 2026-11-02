/**
 * forestView (src/server/forest.ts) — the GET /api/forest payload: the world +
 * placements folded through the graph into the forest model, plus the graph
 * slice the page needs. Runs under an isolated LH_DATA_DIR (the seam is
 * evaluated at config.ts load, so every app-module import is dynamic).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import type { WorldFile } from "../src/core/contracts/world.ts";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-forest-server-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { WORLD_FILES } = await import("../config.ts");
const { forestView } = await import("../src/server/forest.ts");
const { stores } = await import("../src/server/stores.ts");

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

const world: WorldFile = {
	version: 1,
	generatedAt: "2026-11-02T00:00:00.000Z",
	degrees: [{ id: "math", name: "Mathematics" }],
	topics: [
		{
			id: "limits",
			name: "Limits",
			scope: "Limits of functions.",
			degrees: ["math"],
			courses: ["Calculus I"],
			prereqs: [],
			position: { x: 1, y: 2 },
		},
		{
			id: "series",
			name: "Series",
			scope: "Infinite series.",
			degrees: ["math"],
			courses: ["Calculus II"],
			prereqs: ["limits"],
			position: { x: 5, y: 6 },
		},
	],
};

before(() => {
	stores.graphStore.appendNode({
		id: "n_forest1",
		name: "Epsilon-delta",
		statement: "A limit is defined by epsilon and delta.",
		aliases: [],
		createdAt: "2026-11-02T00:00:00.000Z",
		provenance: [],
	});
});

beforeEach(() => {
	fs.rmSync(WORLD_FILES.dir, { recursive: true, force: true });
});

describe("forestView", () => {
	it("folds the world, placements and graph into a model plus the graph slice", () => {
		stores.worldStore.writeWorld(world);
		stores.worldStore.appendPlacement({
			nodeId: "n_forest1",
			topicId: "limits",
			placedAt: "2026-11-02T00:00:01.000Z",
		});

		const snap = forestView();
		assert.ok(snap.model);
		assert.deepEqual(snap.model.coverage, { mapped: 1, total: 2 });
		assert.deepEqual(snap.model.topics.find((t) => t.id === "limits")?.ideas, ["n_forest1"]);
		assert.deepEqual(
			snap.graph.propositions.map((n) => n.id),
			["n_forest1"],
		);
		assert.deepEqual(Object.keys(snap.graph).sort(), [
			"chains",
			"fileSources",
			"nodeSessions",
			"propositions",
			"sessions",
		]);
	});

	it("has a null model when there is no world file, but still fills the graph", () => {
		const snap = forestView();
		assert.equal(snap.model, null);
		assert.ok(snap.graph.propositions.some((n) => n.id === "n_forest1"));
	});
});
