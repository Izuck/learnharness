/**
 * Pins the `test` script's LH_DATA_DIR= override: a run must never resolve
 * a developer's real data folder from their shell environment.
 */
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

test("tests never resolve the developer's LH_DATA_DIR", async () => {
	const { PATHS, ROOT } = await import("../config.ts");
	assert.equal(PATHS.data, path.join(ROOT, "data"));
});
