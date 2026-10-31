/**
 * A tool call the app never offered (a plugin, a native CLI tool) must not
 * kill the lesson turn: it is ignored and logged, the CLI answers it with an
 * error result, and the model carries on. Only a successful result for such a
 * call, meaning the CLI ran it itself, fails the turn.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";

import type { AssistantMessageEvent, Tool } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";

import { CLAUDE_CODE_MODELS } from "../src/agent/claude-code/provider.ts";
import { createClaudeCodeStreamFunction, type RunClaude } from "../src/agent/claude-code/stream.ts";

const FAKE_CLAUDE = fileURLToPath(new URL("./fixtures/claude-code/fake-claude.mjs", import.meta.url));
const HOLD = JSON.stringify({ fake: "hold" });
const READ_TOOL: Tool = { name: "read", description: "Read a file", parameters: { type: "object", properties: {} } };

function streamEvent(event: object): string {
	return JSON.stringify({ type: "stream_event", event });
}

function toolUseBlock(index: number, id: string, name: string, input: object): string[] {
	return [
		streamEvent({ type: "content_block_start", index, content_block: { type: "tool_use", id, name, input: {} } }),
		streamEvent({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } }),
		streamEvent({ type: "content_block_stop", index }),
	];
}

function message(blocks: string[], stopReason: string): string[] {
	return [
		streamEvent({ type: "message_start", message: { usage: {} } }),
		...blocks,
		streamEvent({ type: "message_delta", delta: { stop_reason: stopReason }, usage: {} }),
		streamEvent({ type: "message_stop" }),
	];
}

function textBlock(index: number, text: string): string[] {
	return [
		streamEvent({ type: "content_block_start", index, content_block: { type: "text", text: "" } }),
		streamEvent({ type: "content_block_delta", index, delta: { type: "text_delta", text } }),
		streamEvent({ type: "content_block_stop", index }),
	];
}

function cliResult(id: string, isError: boolean): string {
	return JSON.stringify({ type: "user", message: { content: [
		{ type: "tool_result", tool_use_id: id, is_error: isError, content: isError ? "No such tool available: Read" : "file contents" },
	] } });
}

function run(t: TestContext, scenario: string[]): Promise<AssistantMessageEvent[]> {
	const dir = mkdtempSync(join(tmpdir(), "claude-code-native-test-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const scenarioFile = join(dir, "scenario.jsonl");
	writeFileSync(scenarioFile, `${scenario.join("\n")}\n`);

	const runClaude: RunClaude = (args, options) => {
		const child = spawn(process.execPath, [FAKE_CLAUDE, ...args], {
			cwd: options.cwd,
			env: { ...options.env, FAKE_CLAUDE_SCENARIO: scenarioFile },
			stdio: ["pipe", "pipe", "pipe", "ipc"],
		}) as ChildProcessWithoutNullStreams;
		t.after(() => child.kill("SIGKILL"));
		return child;
	};

	const model = CLAUDE_CODE_MODELS[0];
	assert.ok(model);
	const context = normalizeContext({
		systemPrompt: "You are a tutor.",
		messages: [{ role: "user", content: "hi", timestamp: 0 }],
		tools: [READ_TOOL],
	});
	return (async () => {
		const events: AssistantMessageEvent[] = [];
		for await (const event of createClaudeCodeStreamFunction(runClaude)(model, context, { sessionId: "native-tool-chat" })) events.push(event);
		return events;
	})();
}

test("a native tool call the CLI rejects is ignored and the turn carries on", async (t) => {
	const warn = t.mock.method(console, "warn", () => {});
	const events = await run(t, [
		...message(toolUseBlock(0, "toolu_native", "Read", { file_path: "x" }), "tool_use"),
		cliResult("toolu_native", true),
		...message(textBlock(0, "Carrying on."), "end_turn"),
	]);

	const last = events.at(-1);
	assert.ok(last?.type === "done", `turn ended with ${last?.type}`);
	assert.equal(last.reason, "stop");
	assert.deepEqual(last.message.content, [{ type: "text", text: "Carrying on." }]);
	assert.equal(events.some((event) => event.type === "toolcall_start" || event.type === "toolcall_end"), false);
	assert.deepEqual(warn.mock.calls.map((call) => call.arguments), [["claude CLI native tool call ignored:", "Read"]]);
});

test("a native tool call beside a bridge call is ignored and only the bridge call is admitted", async (t) => {
	t.mock.method(console, "warn", () => {});
	const events = await run(t, [
		...message([
			...toolUseBlock(0, "toolu_native", "Read", { file_path: "x" }),
			...toolUseBlock(1, "toolu_bridge", "mcp__learnharness__read", { path: "a" }),
		], "tool_use"),
		cliResult("toolu_native", true),
		JSON.stringify({ fake: "call", id: "toolu_bridge", name: "read", arguments: { path: "a" } }),
		HOLD,
	]);

	const last = events.at(-1);
	assert.ok(last?.type === "done", `turn ended with ${last?.type}`);
	assert.equal(last.reason, "toolUse");
	assert.deepEqual(last.message.content.map((block) => block.type === "toolCall" ? block.id : block.type), ["toolu_bridge"]);
});

test("a successful result for a native tool call fails the turn and names the tool", async (t) => {
	t.mock.method(console, "warn", () => {});
	const events = await run(t, [
		...message(toolUseBlock(0, "toolu_native", "Read", { file_path: "x" }), "tool_use"),
		cliResult("toolu_native", false),
		HOLD,
	]);

	const last = events.at(-1);
	assert.ok(last?.type === "error", `turn ended with ${last?.type}`);
	assert.match(last.error.errorMessage ?? "", /ran a native tool \(Read\) outside the app/);
});
