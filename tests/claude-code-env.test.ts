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
