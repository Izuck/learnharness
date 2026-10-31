/**
 * Forest spec G: CLI agents get the same output limits as the API, and the
 * version probe runs once per process instead of once per turn.
 */
import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, type spawn } from "node:child_process";
import { test } from "node:test";

import { ANTHROPIC_MODELS } from "@earendil-works/pi-ai/providers/anthropic.models";

import { createClaudeLauncher } from "../src/agent/claude-code/launch.ts";
import { CLAUDE_CODE_MODELS } from "../src/agent/claude-code/provider.ts";
import { toClaudeEnv } from "../src/agent/claude-code/stream.ts";

const cliModel = (id: string) => {
	const model = CLAUDE_CODE_MODELS.find((candidate) => candidate.id === id);
	assert.ok(model, `no CLI model ${id}`);
	return model;
};

test("CLAUDE_CODE_MAX_OUTPUT_TOKENS equals the mapped API model's maxTokens", () => {
	for (const [cli, api] of [["opus", "claude-opus-5-5"], ["sonnet", "claude-sonnet-5-5"], ["haiku", "claude-haiku-5-5"]] as const) {
		const catalog = (ANTHROPIC_MODELS as Record<string, { maxTokens: number } | undefined>)[api];
		assert.ok(catalog, `catalog has ${api}`);
		assert.equal(toClaudeEnv(cliModel(cli)).CLAUDE_CODE_MAX_OUTPUT_TOKENS, String(catalog.maxTokens));
	}
});

test("an unmapped or missing model falls back to 128000", () => {
	assert.equal(toClaudeEnv().CLAUDE_CODE_MAX_OUTPUT_TOKENS, "128000");
	assert.equal(toClaudeEnv({ ...cliModel("opus"), id: "mystery" }).CLAUDE_CODE_MAX_OUTPUT_TOKENS, "128000");
});

test("MAX_MCP_OUTPUT_TOKENS is 50000 and the API key is still stripped", () => {
	process.env.ANTHROPIC_API_KEY = "sk-test";
	try {
		const env = toClaudeEnv(cliModel("opus"));
		assert.equal(env.MAX_MCP_OUTPUT_TOKENS, "50000");
		assert.equal(env.ANTHROPIC_API_KEY, undefined);
	} finally {
		delete process.env.ANTHROPIC_API_KEY;
	}
});

const binary = "/fake/claude";
const options = { cwd: "/fake/work", env: { NODE_ENV: "test" as const } };
const child = {} as ChildProcessWithoutNullStreams;

test("two launches with the same binary check the version once", async () => {
	let probes = 0;
	const launch = createClaudeLauncher({
		findBinary: () => binary,
		readVersion: async () => { probes++; return "2.1.310 (Claude Code)"; },
		spawnProcess: (() => child) as unknown as typeof spawn,
	});
	await launch([], options);
	await launch([], options);
	assert.equal(probes, 1);
});

test("a different binary path is checked on its own", async () => {
	let probes = 0;
	let path = "/fake/a";
	const launch = createClaudeLauncher({
		findBinary: () => path,
		readVersion: async () => { probes++; return "2.1.310"; },
		spawnProcess: (() => child) as unknown as typeof spawn,
	});
	await launch([], options);
	path = "/fake/b";
	await launch([], options);
	assert.equal(probes, 2);
});

test("after a launch error the next launch checks the version again", async () => {
	let probes = 0;
	let fail = true;
	const launch = createClaudeLauncher({
		findBinary: () => binary,
		readVersion: async () => { probes++; return "2.1.310"; },
		spawnProcess: (() => { if (fail) throw new Error("spawn EACCES"); return child; }) as unknown as typeof spawn,
	});
	await assert.rejects(Promise.resolve(launch([], options)));
	fail = false;
	await launch([], options);
	assert.equal(probes, 2);
});

test("a failed version check is never remembered", async () => {
	let probes = 0;
	const launch = createClaudeLauncher({
		findBinary: () => binary,
		readVersion: async () => { probes++; return probes === 1 ? "2.1.258" : "2.1.310"; },
		spawnProcess: (() => child) as unknown as typeof spawn,
	});
	await assert.rejects(Promise.resolve(launch([], options)));
	await launch([], options);
	assert.equal(probes, 2);
});
