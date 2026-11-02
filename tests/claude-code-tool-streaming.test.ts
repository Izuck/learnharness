/**
 * The Claude Code CLI streams tool calls the way the API provider does:
 * toolcall_start when the block starts, toolcall_delta for every input delta
 * (with the partially parsed arguments on the partial message), toolcall_end
 * only once the authenticated MCP bridge admits the call. Streaming is a
 * preview, never admission: a call that streamed but is not admitted must be
 * gone from the message before it settles, so the UI keeps no phantom card.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";

import type { AssistantMessage, AssistantMessageEvent, Tool } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";

import { CLAUDE_CODE_MODELS } from "../src/agent/claude-code/provider.ts";
import { createClaudeCodeStreamFunction, type RunClaude } from "../src/agent/claude-code/stream.ts";

const FAKE_CLAUDE = fileURLToPath(new URL("./fixtures/claude-code/fake-claude.mjs", import.meta.url));
const HOLD = JSON.stringify({ fake: "hold" });
const SEND_TOOL: Tool = { name: "send_to_user", description: "Send", parameters: { type: "object", properties: {} } };
const READ_TOOL: Tool = { name: "read", description: "Read", parameters: { type: "object", properties: {} } };
const SEND_ID = "toolu_send";
const GUARD_MS = 8000;
// The partial message is one mutable object, so a consumer only sees a delta's state if the next one is not yet written.
const SLEEP = JSON.stringify({ fake: "sleep", ms: 40 });

function streamEvent(event: object): string {
	return JSON.stringify({ type: "stream_event", event });
}

function textBlock(index: number, text: string): string[] {
	return [
		streamEvent({ type: "content_block_start", index, content_block: { type: "text", text: "" } }),
		streamEvent({ type: "content_block_delta", index, delta: { type: "text_delta", text } }),
		streamEvent({ type: "content_block_stop", index }),
	];
}

function streamedToolBlock(index: number, id: string, name: string, chunks: string[]): string[] {
	return [
		streamEvent({ type: "content_block_start", index, content_block: { type: "tool_use", id, name: `mcp__learnharness__${name}`, input: {} } }),
		...chunks.flatMap((partial_json) => [streamEvent({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json } }), SLEEP]),
		streamEvent({ type: "content_block_stop", index }),
	];
}

function toolMessage(blocks: string[]): string[] {
	return [
		streamEvent({ type: "message_start", message: { usage: {} } }),
		...blocks,
		streamEvent({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: {} }),
		streamEvent({ type: "message_stop" }),
	];
}

const SEND_CHUNKS = ['{"mess', 'age":"Hel', 'lo wor', 'ld"}'];

function fakeRun(t: TestContext, scenario: string[]): RunClaude {
	const dir = mkdtempSync(join(tmpdir(), "claude-code-toolstream-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const scenarioFile = join(dir, "scenario.jsonl");
	writeFileSync(scenarioFile, `${scenario.join("\n")}\n`);
	return (args, options) => {
		const child = spawn(process.execPath, [FAKE_CLAUDE, ...args], {
			cwd: options.cwd,
			env: { ...options.env, FAKE_CLAUDE_SCENARIO: scenarioFile },
			stdio: ["pipe", "pipe", "pipe", "ipc"],
		}) as ChildProcessWithoutNullStreams;
		t.after(() => child.kill("SIGKILL"));
		return child;
	};
}

type Seen = { event: AssistantMessageEvent; content: AssistantMessage["content"] };

/** Runs a scenario; `onEvent` may abort. Content is snapshotted per event because partial is one mutable object. */
async function run(t: TestContext, scenario: string[], onEvent?: (event: AssistantMessageEvent, abort: () => void) => void): Promise<Seen[]> {
	const model = CLAUDE_CODE_MODELS[0];
	assert.ok(model);
	const context = normalizeContext({ systemPrompt: "You are a tutor.", messages: [{ role: "user", content: "hi", timestamp: 0 }], tools: [SEND_TOOL, READ_TOOL] });
	const controller = new AbortController();
	const seen: Seen[] = [];
	const stream = createClaudeCodeStreamFunction(fakeRun(t, scenario))(model, context, { sessionId: "tool-streaming-chat", signal: controller.signal });
	// A scenario that holds forever must fail the test, not hang it.
	const guard = setTimeout(() => controller.abort(), GUARD_MS);
	t.after(() => clearTimeout(guard));
	for await (const event of stream) {
		const message = "partial" in event ? event.partial : "message" in event ? event.message : event.error;
		seen.push({ event, content: structuredClone(message.content) });
		onEvent?.(event, () => controller.abort());
	}
	return seen;
}

function finalMessage(seen: Seen[]): AssistantMessage {
	const last = seen.at(-1)?.event;
	assert.ok(last);
	if (last.type === "done") return last.message;
	assert.ok(last.type === "error", `turn ended with ${last.type}`);
	return last.error;
}

function sentMessage(content: AssistantMessage["content"], index: number): string | undefined {
	const block = content[index];
	return block?.type === "toolCall" ? (block.arguments as { message?: string }).message : undefined;
}

function toolEventIndexes(seen: Seen[]): number[] {
	return seen.flatMap(({ event }) => event.type.startsWith("toolcall_") && "contentIndex" in event ? [event.contentIndex] : []);
}

test("send_to_user streams toolcall_start, growing toolcall_delta, then toolcall_end at admission", async (t) => {
	const seen = await run(t, [
		...toolMessage(streamedToolBlock(0, SEND_ID, "send_to_user", SEND_CHUNKS)),
		JSON.stringify({ fake: "call", id: SEND_ID, name: "send_to_user", arguments: { message: "Hello world" } }),
		HOLD,
	]);

	assert.deepEqual(seen.map(({ event }) => event.type), [
		"start", "toolcall_start", "toolcall_delta", "toolcall_delta", "toolcall_delta", "toolcall_delta", "toolcall_end", "done",
	]);
	const deltas = seen.filter(({ event }) => event.type === "toolcall_delta");
	assert.deepEqual(deltas.map(({ event }) => event.type === "toolcall_delta" && event.delta), SEND_CHUNKS);
	assert.deepEqual(deltas.map(({ content }) => sentMessage(content, 0)), [undefined, "Hel", "Hello wor", "Hello world"]);
	// The card exists from the start, and the index never moves.
	assert.deepEqual(toolEventIndexes(seen), Array(6).fill(0));

	const end = seen.find(({ event }) => event.type === "toolcall_end")?.event;
	assert.ok(end?.type === "toolcall_end");
	assert.deepEqual(end.toolCall, { type: "toolCall", id: SEND_ID, name: "send_to_user", arguments: { message: "Hello world" } });
	const done = finalMessage(seen);
	assert.equal(done.stopReason, "toolUse");
	assert.deepEqual(done.content, [end.toolCall]);
});

test("a tool call after streamed prose keeps one content index from start to end", async (t) => {
	const seen = await run(t, [
		...toolMessage([...textBlock(0, "First, a thought."), ...streamedToolBlock(1, SEND_ID, "send_to_user", SEND_CHUNKS)]),
		JSON.stringify({ fake: "call", id: SEND_ID, name: "send_to_user", arguments: { message: "Hello world" } }),
		HOLD,
	]);

	assert.ok(toolEventIndexes(seen).length >= 3);
	assert.deepEqual([...new Set(toolEventIndexes(seen))], [1]);
	assert.deepEqual(finalMessage(seen).content.map((block) => block.type), ["text", "toolCall"]);
});

test("a streamed call the CLI refused leaves no tool call in the final message", async (t) => {
	const seen = await run(t, [
		...toolMessage(streamedToolBlock(0, SEND_ID, "send_to_user", SEND_CHUNKS)),
		JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: SEND_ID, is_error: true, content: "invalid arguments" }] } }),
		HOLD,
	]);

	assert.ok(seen.some(({ event }) => event.type === "toolcall_start"), "the preview did stream");
	assert.equal(seen.some(({ event }) => event.type === "toolcall_end"), false);
	const final = finalMessage(seen);
	assert.equal(seen.at(-1)?.event.type, "error");
	assert.match(final.errorMessage ?? "", /refused.*before MCP admission/);
	assert.deepEqual(final.content, []);
});

test("a streamed call is withdrawn from the message when the turn is aborted before admission", async (t) => {
	let deltas = 0;
	const seen = await run(t, [...toolMessage(streamedToolBlock(0, SEND_ID, "send_to_user", SEND_CHUNKS)), HOLD], (event, abort) => {
		if (event.type === "toolcall_delta" && ++deltas === SEND_CHUNKS.length) abort();
	});

	assert.equal(deltas, SEND_CHUNKS.length, "the call streamed before the abort");
	assert.equal(seen.some(({ event }) => event.type === "toolcall_end"), false);
	const last = seen.at(-1)?.event;
	assert.ok(last?.type === "error" && last.reason === "aborted");
	assert.deepEqual(finalMessage(seen).content, []);
});

test("a streamed call is withdrawn when the process exits without ever admitting it", async (t) => {
	const seen = await run(t, [
		...toolMessage([...textBlock(0, "Intro."), ...streamedToolBlock(1, SEND_ID, "send_to_user", SEND_CHUNKS)]),
		JSON.stringify({ fake: "exit", code: 1, stderr: "denied" }),
	]);

	assert.equal(seen.at(-1)?.event.type, "error");
	assert.equal(seen.some(({ event }) => event.type === "toolcall_end"), false);
	assert.deepEqual(finalMessage(seen).content, [{ type: "text", text: "Intro." }]);
});

test("a call whose MCP arguments differ from the streamed intent still fails closed, with no tool call left", async (t) => {
	const seen = await run(t, [
		...toolMessage(streamedToolBlock(0, SEND_ID, "send_to_user", SEND_CHUNKS)),
		JSON.stringify({ fake: "call", id: SEND_ID, name: "send_to_user", arguments: { message: "Something else" } }),
		HOLD,
	]);

	assert.equal(seen.some(({ event }) => event.type === "toolcall_end"), false);
	assert.match(finalMessage(seen).errorMessage ?? "", /does not match its streamed tool intent/);
	assert.deepEqual(finalMessage(seen).content, []);
});

test("a native tool block is still never shown beside a streamed bridge call", async (t) => {
	t.mock.method(console, "warn", () => {});
	const native = [
		streamEvent({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_native", name: "Read", input: {} } }),
		streamEvent({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"file_path":"x"}' } }),
		streamEvent({ type: "content_block_stop", index: 0 }),
	];
	const seen = await run(t, [
		...toolMessage([...native, ...streamedToolBlock(1, SEND_ID, "send_to_user", SEND_CHUNKS)]),
		JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_native", is_error: true, content: "No such tool available: Read" }] } }),
		JSON.stringify({ fake: "call", id: SEND_ID, name: "send_to_user", arguments: { message: "Hello world" } }),
		HOLD,
	]);

	assert.deepEqual(finalMessage(seen).content.map((block) => block.type === "toolCall" && block.name), ["send_to_user"]);
	assert.deepEqual([...new Set(toolEventIndexes(seen))], [0]);
});
