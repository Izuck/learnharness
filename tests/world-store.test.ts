/**
 * Tests for the WORLD store (src/store/world.ts) — the Cartographer's fs
 * adapter. Writes the real repo data/world/ (npm test's shared data/,
 * disposable scratch by doctrine); a pre-existing data/world/ is snapshotted
 * to a temp dir and restored so the worktree's own dev state survives.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { WORLD_FILES } from "../config.ts";
import type { WorldFile } from "../src/core/contracts/world.ts";
import { worldStore } from "../src/store/world.ts";

const snapshot = fs.mkdtempSync(path.join(os.tmpdir(), "lh-world-snap-"));
const hadWorld = fs.existsSync(WORLD_FILES.dir);
if (hadWorld) fs.cpSync(WORLD_FILES.dir, path.join(snapshot, "world"), { recursive: true });

beforeEach(() => {
	fs.rmSync(WORLD_FILES.dir, { recursive: true, force: true });
});
afterEach(() => {
	fs.rmSync(WORLD_FILES.dir, { recursive: true, force: true });
});
after(() => {
	fs.rmSync(WORLD_FILES.dir, { recursive: true, force: true });
	if (hadWorld) fs.cpSync(path.join(snapshot, "world"), WORLD_FILES.dir, { recursive: true });
	fs.rmSync(snapshot, { recursive: true, force: true });
});

const world: WorldFile = {
	version: 1,
	generatedAt: "2026-10-30T00:00:00.000Z",
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
	],
};

describe("the world store", () => {
	it("reads null when nothing has been written", () => {
		assert.equal(worldStore.readWorld(), null);
	});

	it("write then read round-trips the world", () => {
		worldStore.writeWorld(world);
		assert.deepEqual(worldStore.readWorld(), world);
		const leftovers = fs.readdirSync(WORLD_FILES.dir).filter((f) => f.includes(".tmp"));
		assert.deepEqual(leftovers, []);
	});

	it("reads an invalid topics.json as null", () => {
		fs.mkdirSync(WORLD_FILES.dir, { recursive: true });
		fs.writeFileSync(WORLD_FILES.topics, JSON.stringify({ version: 1, topics: "nope" }));
		assert.equal(worldStore.readWorld(), null);
		fs.writeFileSync(WORLD_FILES.topics, "{not json");
		assert.equal(worldStore.readWorld(), null);
	});

	it("appends placements in order and skips corrupt lines", () => {
		const a = { nodeId: "n1", topicId: "limits", placedAt: "2026-10-30T00:00:01.000Z" };
		const b = { nodeId: "n2", topicId: null, placedAt: "2026-10-30T00:00:02.000Z" };
		worldStore.appendPlacement(a);
		fs.appendFileSync(WORLD_FILES.placements, "{torn line\n", "utf-8");
		fs.appendFileSync(WORLD_FILES.placements, `${JSON.stringify({ nodeId: 3 })}\n`, "utf-8");
		worldStore.appendPlacement(b);
		assert.deepEqual(worldStore.readPlacements(), [a, b]);
	});

	it("reads no placements before the ledger exists", () => {
		assert.deepEqual(worldStore.readPlacements(), []);
	});
});
