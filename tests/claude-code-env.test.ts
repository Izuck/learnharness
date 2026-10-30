/**
 * The Claude Code child process must bill the signed-in plan, never an API key
 * (src/agent/claude-code/stream.ts toClaudeEnv).
 */
import assert from "node:assert/strict";
import test from "node:test";

import { toClaudeEnv } from "../src/agent/claude-code/stream.ts";

test("strips ANTHROPIC_API_KEY from the claude child env", () => {
	process.env.ANTHROPIC_API_KEY = "sk-test";
	try {
		assert.equal(toClaudeEnv().ANTHROPIC_API_KEY, undefined);
	} finally {
		delete process.env.ANTHROPIC_API_KEY;
	}
});

test("strips ANTHROPIC_API_KEY under any casing (Windows env names are case-insensitive)", () => {
	process.env.Anthropic_Api_Key = "sk-test";
	try {
		const env = toClaudeEnv();
		const leaked = Object.keys(env).filter((name) => name.toUpperCase() === "ANTHROPIC_API_KEY");
		assert.deepEqual(leaked, []);
	} finally {
		delete process.env.Anthropic_Api_Key;
	}
});
