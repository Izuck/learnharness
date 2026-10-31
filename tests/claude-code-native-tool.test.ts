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

import { joinTextBlocks } from "../src/core/text-blocks.ts";
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

/** A tool_result whose is_error flag and content are exactly as given (the flag may be absent). */
function rawResult(id: string, content: unknown, isError?: boolean): string {
	return JSON.stringify({ type: "user", message: { content: [
		{ type: "tool_result", tool_use_id: id, content, ...(isError === undefined ? {} : { is_error: isError }) },
	] } });
}

function nativeOnlyMessage(id: string): string[] {
	return [...message(toolUseBlock(0, id, "Read", { file_path: "x" }), "tool_use"), cliResult(id, true)];
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
	assert.deepEqual(warn.mock.calls.map((call) => call.arguments), [
		["claude CLI native tool call ignored:", "Read"],
		["claude CLI declined native tool call:", "Read", "No such tool available: Read"],
	]);
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

test("two native-only messages in a row are tolerated and the turn still finishes", async (t) => {
	t.mock.method(console, "warn", () => {});
	const events = await run(t, [
		...nativeOnlyMessage("toolu_n1"),
		...nativeOnlyMessage("toolu_n2"),
		...message(textBlock(0, "Carrying on."), "end_turn"),
	]);

	const last = events.at(-1);
	assert.ok(last?.type === "done", `turn ended with ${last?.type}`);
	assert.deepEqual(last.message.content, [{ type: "text", text: "Carrying on." }]);
});

test("a model that keeps calling tools the app does not offer fails the turn on the fourth native-only message", async (t) => {
	t.mock.method(console, "warn", () => {});
	const events = await run(t, [
		...nativeOnlyMessage("toolu_n1"),
		...nativeOnlyMessage("toolu_n2"),
		...nativeOnlyMessage("toolu_n3"),
		...nativeOnlyMessage("toolu_n4"),
		...message(textBlock(0, "never reached"), "end_turn"),
	]);

	const last = events.at(-1);
	assert.ok(last?.type === "error", `turn ended with ${last?.type}`);
	assert.equal(last.error.errorMessage, "claude CLI kept calling tools the app does not offer (Read)");
	assert.equal(events.some((event) => event.type === "toolcall_end"), false);
});

test("the failure for a native tool the CLI ran carries a truncated copy of its result", async (t) => {
	t.mock.method(console, "warn", () => {});
	const events = await run(t, [
		...message(toolUseBlock(0, "toolu_native", "Read", { file_path: "x" }), "tool_use"),
		rawResult("toolu_native", [{ type: "text", text: `${"a".repeat(200)}${"b".repeat(100)}` }], false),
		HOLD,
	]);

	const last = events.at(-1);
	assert.ok(last?.type === "error", `turn ended with ${last?.type}`);
	assert.equal(last.error.errorMessage, `claude CLI ran a native tool (Read) outside the app: ${"a".repeat(200)}`);
});

test("a result wrapped in tool_use_error counts as declined even without is_error", async (t) => {
	const warn = t.mock.method(console, "warn", () => {});
	const events = await run(t, [
		...message(toolUseBlock(0, "toolu_native", "Read", { file_path: "x" }), "tool_use"),
		rawResult("toolu_native", "<tool_use_error>Error: No such tool available: Read</tool_use_error>"),
		...message(textBlock(0, "Carrying on."), "end_turn"),
	]);

	const last = events.at(-1);
	assert.ok(last?.type === "done", `turn ended with ${last?.type}`);
	assert.deepEqual(warn.mock.calls.at(-1)?.arguments, ["claude CLI declined native tool call:", "Read", "<tool_use_error>Error: No such tool available: Read</tool_use_error>"]);
});

test("a result with no is_error and no tool_use_error wrapper still fails closed", async (t) => {
	const warn = t.mock.method(console, "warn", () => {});
	const events = await run(t, [
		...message(toolUseBlock(0, "toolu_native", "Read", { file_path: "x" }), "tool_use"),
		rawResult("toolu_native", "file contents"),
		HOLD,
	]);

	const last = events.at(-1);
	assert.ok(last?.type === "error", `turn ended with ${last?.type}`);
	assert.match(last.error.errorMessage ?? "", /ran a native tool \(Read\) outside the app: file contents/);
	assert.deepEqual(warn.mock.calls.at(-1)?.arguments, ["claude CLI ran native tool call outside the app:", "Read", "file contents"]);
});

test("an authenticated MCP call carrying an ignored native call's id is never admitted", async (t) => {
	t.mock.method(console, "warn", () => {});
	const events = await run(t, [
		...message(toolUseBlock(0, "toolu_native", "Read", { file_path: "x" }), "tool_use"),
		JSON.stringify({ fake: "start-call", id: "toolu_native", name: "read", arguments: { path: "x" } }),
		cliResult("toolu_native", true),
		...message(textBlock(0, "Carrying on."), "end_turn"),
	]);

	const last = events.at(-1);
	assert.ok(last?.type === "done", `turn ended with ${last?.type}`);
	assert.equal(last.reason, "stop");
	assert.equal(last.message.content.some((block) => block.type === "toolCall"), false);
	assert.equal(events.some((event) => event.type === "toolcall_start" || event.type === "toolcall_end"), false);
});

test("beside a real bridge call, an MCP call carrying the ignored native id fails closed instead of being admitted", async (t) => {
	t.mock.method(console, "warn", () => {});
	const events = await run(t, [
		...message([
			...toolUseBlock(0, "toolu_native", "Read", { file_path: "x" }),
			...toolUseBlock(1, "toolu_bridge", "mcp__learnharness__read", { path: "a" }),
		], "tool_use"),
		JSON.stringify({ fake: "start-call", id: "toolu_native", name: "read", arguments: { path: "x" } }),
		HOLD,
	]);

	const last = events.at(-1);
	assert.ok(last?.type === "error", `turn ended with ${last?.type}`);
	assert.match(last.error.errorMessage ?? "", /does not match its streamed tool intent/);
	assert.equal(events.some((event) => event.type === "toolcall_end"), false);
});

function thinkingBlock(index: number, thinking: string): string[] {
	return [
		streamEvent({ type: "content_block_start", index, content_block: { type: "thinking", thinking: "" } }),
		streamEvent({ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking } }),
		streamEvent({ type: "content_block_stop", index }),
	];
}

function textsOf(content: readonly { type: string; text?: string }[]): string[] {
	return content.flatMap((block) => block.type === "text" ? [block.text ?? ""] : []);
}

test("[text, native] then [text]: no synthetic text is persisted, and the consumer join separates the two", async (t) => {
	t.mock.method(console, "warn", () => {});
	const events = await run(t, [
		...message([...textBlock(0, "Let me check."), ...toolUseBlock(1, "toolu_native", "Read", { file_path: "x" })], "tool_use"),
		cliResult("toolu_native", true),
		...message(textBlock(0, "Carrying on."), "end_turn"),
	]);

	const last = events.at(-1);
	assert.ok(last?.type === "done", `turn ended with ${last?.type}`);
	assert.deepEqual(textsOf(last.message.content), ["Let me check.", "Carrying on."]);
	assert.equal(joinTextBlocks(last.message.content), "Let me check.\n\nCarrying on.");
});

test("[text, native] then [thinking, text]: the consumer join still separates the texts", async (t) => {
	t.mock.method(console, "warn", () => {});
	const events = await run(t, [
		...message([...textBlock(0, "Let me check."), ...toolUseBlock(1, "toolu_native", "Read", { file_path: "x" })], "tool_use"),
		cliResult("toolu_native", true),
		...message([...thinkingBlock(0, "hm"), ...textBlock(1, "Carrying on.")], "end_turn"),
	]);

	const last = events.at(-1);
	assert.ok(last?.type === "done", `turn ended with ${last?.type}`);
	assert.deepEqual(textsOf(last.message.content), ["Let me check.", "Carrying on."]);
	assert.equal(joinTextBlocks(last.message.content), "Let me check.\n\nCarrying on.");
});

test("[text, native, text, bridge call] in one message: the consumer join separates the texts", async (t) => {
	t.mock.method(console, "warn", () => {});
	const events = await run(t, [
		...message([
			...textBlock(0, "Let me check."),
			...toolUseBlock(1, "toolu_native", "Read", { file_path: "x" }),
			...textBlock(2, "Now the real one."),
			...toolUseBlock(3, "toolu_bridge", "mcp__learnharness__read", { path: "a" }),
		], "tool_use"),
		cliResult("toolu_native", true),
		JSON.stringify({ fake: "call", id: "toolu_bridge", name: "read", arguments: { path: "a" } }),
		HOLD,
	]);

	const last = events.at(-1);
	assert.ok(last?.type === "done", `turn ended with ${last?.type}`);
	assert.equal(last.reason, "toolUse");
	assert.deepEqual(textsOf(last.message.content), ["Let me check.", "Now the real one."]);
	assert.equal(joinTextBlocks(last.message.content), "Let me check.\n\nNow the real one.");
});
