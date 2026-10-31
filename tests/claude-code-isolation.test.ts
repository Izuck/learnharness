/**
 * The tutor's Claude Code agents must not inherit the owner's personal Claude Code setup
 * (user plugins, output style, global CLAUDE.md). Chosen by scripts/parity/probe-isolation.ts:
 * `--setting-sources local` loads no user plugins and the default output style, and the CLI
 * still signs in on the plan, because sign-in is the credential store, not a settings source.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { toClaudeArgs } from "../src/agent/claude-code/stream.ts";

const args = toClaudeArgs({
	model: "haiku",
	effort: "low",
	systemPromptFile: "/private/system-prompt.md",
	mcpConfigFile: "/private/mcp.json",
	allowedTools: ["mcp__learnharness__read"],
});

function valueAfter(flag: string): string | undefined {
	const index = args.indexOf(flag);
	return index < 0 ? undefined : args[index + 1];
}

test("toClaudeArgs reads settings from the local source only, never the user's", () => {
	assert.equal(valueAfter("--setting-sources"), "local");
	assert.equal(args.filter((arg) => arg === "--setting-sources").length, 1);
	assert.equal(args.includes("user"), false);
});

test("toClaudeArgs keeps the app's tools-only-over-the-bridge isolation", () => {
	assert.ok(args.includes("--strict-mcp-config"));
	assert.equal(valueAfter("--mcp-config"), "/private/mcp.json");
	assert.equal(valueAfter("--tools"), "");
	assert.equal(valueAfter("--settings"), '{"disableAllHooks":true}');
	assert.ok(args.includes("--disable-slash-commands"));
});
