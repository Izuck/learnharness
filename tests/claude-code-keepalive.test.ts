/**
 * One live Claude Code CLI process per lesson (forest spec C): a turn that ends
 * normally keeps its process idle with stdin open, and the learner's next
 * message is written to that process instead of replaying the whole lesson.
 * Anything that is not plainly "the same lesson plus new user messages" kills
 * the idle process and falls back to the fresh replay.
 *
 * The runClaude seam spawns tests/fixtures/claude-code/fake-claude.mjs; its
 * "wait-for-user" directive holds a scenario until the next stdin user line,
 * so one scenario can script several turns of one process.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";

import type { AssistantMessage, AssistantMessageEvent, JsonObject, Message, SimpleStreamOptions, Tool, ToolResultMessage } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";

import {
	IDLE_TURN_TIMEOUT_MS,
	addIdleProcess,
	addLiveProcess,
	MAX_IDLE_PROCESSES,
	endLiveSession,
	idleTurnTimeoutMs,
	killAllLiveProcesses,
} from "../src/agent/claude-code/live-processes.ts";
import { CLAUDE_CODE_MODELS } from "../src/agent/claude-code/provider.ts";
import { createClaudeCodeStreamFunction, type RunClaude } from "../src/agent/claude-code/stream.ts";
import { toStreamJsonLine } from "../src/agent/claude-code/transcript.ts";

const FAKE_CLAUDE = fileURLToPath(new URL("./fixtures/claude-code/fake-claude.mjs", import.meta.url));
const WAIT_FOR_USER = JSON.stringify({ fake: "wait-for-user" });
const HOLD = JSON.stringify({ fake: "hold" });
const CLEANUP_TIMEOUT_MS = 3000;
const SESSION_ID = "keepalive-lesson";
const READ_TOOL: Tool = { name: "read", description: "Read a file", parameters: { type: "object", properties: {} } };
const HI: Message = { role: "user", content: "hi", timestamp: 0 };
const NEXT: Message = { role: "user", content: "and then?", timestamp: 1 };

type Spawn = { child: ChildProcessWithoutNullStreams; stdinFile: string };
type ToolUse = { id: string; name: string; arguments: JsonObject };

function streamEvent(event: object): string {
	return JSON.stringify({ type: "stream_event", event });
}

type Usage = { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };

/** One complete text response, as the CLI streams it, with its plan-limit trailer after message_stop. */
function textMessage(text: string, usage: Usage = {}): string[] {
	return [
		streamEvent({ type: "message_start", message: { usage } }),
		streamEvent({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
		streamEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }),
		streamEvent({ type: "content_block_stop", index: 0 }),
		streamEvent({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage }),
		streamEvent({ type: "message_stop" }),
		JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "allowed" } }),
		JSON.stringify({ type: "result", subtype: "success", is_error: false, result: text }),
	];
}

function toolUseMessage(toolUse: ToolUse): string[] {
	return [
		streamEvent({ type: "message_start", message: { usage: {} } }),
		streamEvent({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: toolUse.id, name: `mcp__learnharness__${toolUse.name}`, input: {} } }),
		streamEvent({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(toolUse.arguments) } }),
		streamEvent({ type: "content_block_stop", index: 0 }),
		streamEvent({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: {} }),
		streamEvent({ type: "message_stop" }),
	];
}

function nativeOnlyMessage(id: string): string[] {
	return [
		streamEvent({ type: "message_start", message: { usage: {} } }),
		streamEvent({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name: "Read", input: {} } }),
		streamEvent({ type: "content_block_stop", index: 0 }),
		streamEvent({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: {} }),
		streamEvent({ type: "message_stop" }),
		JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, is_error: true, content: "No such tool available: Read" }] } }),
	];
}

function toToolResult(toolUse: ToolUse, text: string): ToolResultMessage {
	return { role: "toolResult", toolCallId: toolUse.id, toolName: toolUse.name, content: [{ type: "text", text }], isError: false, timestamp: 0 };
}

/** Spawn n runs scenario n (the last one repeats), recording each child and its stdin. */
function createFakeRun(t: TestContext, scenarios: string[][]): { runClaude: RunClaude; spawns: Spawn[] } {
	const dir = mkdtempSync(join(tmpdir(), "claude-code-keepalive-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	// Idle processes outlive their test unless something ends them.
	t.after(() => killAllLiveProcesses());
	const spawns: Spawn[] = [];
	const runClaude: RunClaude = (args, options) => {
		const index = spawns.length;
		const scenario = scenarios[Math.min(index, scenarios.length - 1)]!;
		const scenarioFile = join(dir, `scenario-${index}.jsonl`);
		const stdinFile = join(dir, `stdin-${index}.jsonl`);
		writeFileSync(scenarioFile, `${scenario.join("\n")}\n`);
		const child = spawn(process.execPath, [FAKE_CLAUDE, ...args], {
			cwd: options.cwd,
			env: { ...options.env, FAKE_CLAUDE_SCENARIO: scenarioFile, FAKE_CLAUDE_STDIN: stdinFile },
			stdio: ["pipe", "pipe", "pipe", "ipc"],
		}) as ChildProcessWithoutNullStreams;
		t.after(() => child.kill("SIGKILL"));
		spawns.push({ child, stdinFile });
		return child;
	};
	return { runClaude, spawns };
}

function getModel() {
	const model = CLAUDE_CODE_MODELS[0];
	assert.ok(model);
	return model;
}

async function collect(stream: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

type StreamFn = ReturnType<typeof createClaudeCodeStreamFunction>;

async function runTurn(stream: StreamFn, messages: Message[], options: SimpleStreamOptions = {}, systemPrompt = "You are a tutor."): Promise<AssistantMessage> {
	const context = normalizeContext({ systemPrompt, messages, tools: [READ_TOOL] });
	const events = await collect(stream(getModel(), context, { sessionId: SESSION_ID, ...options }));
	const last = events.at(-1);
	assert.ok(last?.type === "done", `turn ended with ${last?.type}: ${last?.type === "error" ? last.error.errorMessage : ""}`);
	return last.message;
}

function textOf(message: AssistantMessage): string {
	return message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
}

function isAlive(child: ChildProcessWithoutNullStreams): boolean {
	return child.exitCode === null && child.signalCode === null;
}

async function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
	if (!isAlive(child)) return;
	await assert.doesNotReject(once(child, "exit", { signal: AbortSignal.timeout(CLEANUP_TIMEOUT_MS) }), "claude CLI process was not killed");
}

/** The stdin user lines a spawn received (control requests left out). */
function userLines(spawn: Spawn): string[] {
	return readFileSync(spawn.stdinFile, "utf8").split("\n").filter(Boolean).filter((line) => JSON.parse(line).type === "user");
}

test("a finished turn keeps its process: the next learner message continues the same child with only that message", async (t) => {
	const init = JSON.stringify({ type: "system", subtype: "init", model: "claude-resolved-5" });
	const { runClaude, spawns } = createFakeRun(t, [[
		init,
		...textMessage("first answer", { input_tokens: 10, output_tokens: 3 }),
		WAIT_FOR_USER,
		...textMessage("second answer", { input_tokens: 4, output_tokens: 5, cache_read_input_tokens: 40 }),
	]]);
	const stream = createClaudeCodeStreamFunction(runClaude);

	const first = await runTurn(stream, [HI]);
	assert.equal(textOf(first), "first answer");
	assert.equal(spawns.length, 1);
	assert.ok(isAlive(spawns[0]!.child), "a finished lesson turn keeps its CLI process");

	const second = await runTurn(stream, [HI, first, NEXT]);
	assert.equal(textOf(second), "second answer");
	assert.equal(spawns.length, 1, "the next message must reuse the live process, not replay the lesson");
	assert.deepEqual(userLines(spawns[0]!), [toStreamJsonLine([{ type: "text", text: "hi" }]), toStreamJsonLine([{ type: "text", text: "and then?" }])]);

	// Each turn reports its own message's usage, and the once-per-process init model rides every turn.
	assert.deepEqual([first.usage.input, first.usage.output, first.usage.totalTokens], [10, 3, 13]);
	assert.deepEqual([second.usage.input, second.usage.output, second.usage.cacheRead, second.usage.totalTokens], [4, 5, 40, 49]);
	assert.equal((second as { cliResolvedModel?: string }).cliResolvedModel, "claude-resolved-5");
	assert.deepEqual((second as { cliRateLimit?: unknown }).cliRateLimit, { status: "allowed" });

	killAllLiveProcesses();
	await waitForExit(spawns[0]!.child);
});

test("several new user messages go to the live process as one user message", async (t) => {
	const { runClaude, spawns } = createFakeRun(t, [[...textMessage("one"), WAIT_FOR_USER, ...textMessage("two")]]);
	const stream = createClaudeCodeStreamFunction(runClaude);
	const first = await runTurn(stream, [HI]);
	const also: Message = { role: "user", content: [{ type: "text", text: "also this" }], timestamp: 2 };
	const second = await runTurn(stream, [HI, first, NEXT, also]);
	assert.equal(textOf(second), "two");
	assert.equal(spawns.length, 1);
	assert.deepEqual(userLines(spawns[0]!).slice(1), [toStreamJsonLine([{ type: "text", text: "and then?" }, { type: "text", text: "also this" }])]);
});

const MISMATCHES: Record<string, (first: AssistantMessage) => { messages: Message[]; options?: SimpleStreamOptions; systemPrompt?: string }> = {
	"an edited earlier message": (first) => ({ messages: [{ ...HI, content: "hello, edited" }, first, NEXT] }),
	"an edited assistant reply": (first) => ({ messages: [HI, { ...first, content: [{ type: "text", text: "something else" }] }, NEXT] }),
	"a retried message (history is not an extension)": () => ({ messages: [HI] }),
	"no new message": (first) => ({ messages: [HI, first] }),
	"a tool result instead of a user message": (first) => ({ messages: [HI, first, toToolResult({ id: "toolu_x", name: "read", arguments: {} }, "x")] }),
	"a changed effort": (first) => ({ messages: [HI, first, NEXT], options: { reasoning: "high" } }),
	"a changed system prompt": (first) => ({ messages: [HI, first, NEXT], systemPrompt: "You are a different tutor." }),
	"a compacted history": () => ({ messages: [{ ...HI, content: "summary of the lesson so far" }, NEXT] }),
};

for (const [name, change] of Object.entries(MISMATCHES)) test(`${name} kills the idle process and replays on a fresh one`, async (t) => {
	const { runClaude, spawns } = createFakeRun(t, [[...textMessage("one"), WAIT_FOR_USER, ...textMessage("stale")], textMessage("fresh")]);
	const stream = createClaudeCodeStreamFunction(runClaude);
	const first = await runTurn(stream, [HI]);
	const { messages, options, systemPrompt } = change(first);
	const reply = await runTurn(stream, messages, options, systemPrompt);
	assert.equal(textOf(reply), "fresh");
	assert.equal(spawns.length, 2);
	await waitForExit(spawns[0]!.child);
});

test("the replay after a mismatch carries the whole lesson", async (t) => {
	const { runClaude, spawns } = createFakeRun(t, [[...textMessage("one"), WAIT_FOR_USER, ...textMessage("stale")], textMessage("fresh")]);
	const stream = createClaudeCodeStreamFunction(runClaude);
	const first = await runTurn(stream, [HI]);
	await runTurn(stream, [{ ...HI, content: "hello, edited" }, first, NEXT]);
	const [replay] = userLines(spawns[1]!);
	assert.ok(replay?.includes("hello, edited") && replay.includes("[assistant]\\none") && replay.includes("and then?"), replay);
});

test("a caller without a session ID keeps no idle process", async (t) => {
	const { runClaude, spawns } = createFakeRun(t, [[...textMessage("one"), WAIT_FOR_USER, ...textMessage("stale")], textMessage("fresh")]);
	const stream = createClaudeCodeStreamFunction(runClaude);
	const first = await runTurn(stream, [HI], { sessionId: undefined });
	await waitForExit(spawns[0]!.child);
	assert.equal(textOf(await runTurn(stream, [HI, first, NEXT], { sessionId: undefined })), "fresh");
	assert.equal(spawns.length, 2);
});

test("a turn that fails or hits the output cap is not kept", async (t) => {
	const capped = textMessage("cut off").map((line) => line.replace('"end_turn"', '"max_tokens"'));
	const { runClaude, spawns } = createFakeRun(t, [[...capped, WAIT_FOR_USER, ...textMessage("stale")], textMessage("fresh")]);
	const stream = createClaudeCodeStreamFunction(runClaude);
	const context = normalizeContext({ systemPrompt: "You are a tutor.", messages: [HI], tools: [READ_TOOL] });
	const events = await collect(stream(getModel(), context, { sessionId: SESSION_ID }));
	const done = events.at(-1);
	assert.ok(done?.type === "done" && done.reason === "length");
	await waitForExit(spawns[0]!.child);
	assert.equal(textOf(await runTurn(stream, [HI, done.message, NEXT])), "fresh");
	assert.equal(spawns.length, 2);
});

test("the idle timeout kills the process and the next message replays", async (t) => {
	idleTurnTimeoutMs.current = 100;
	t.after(() => (idleTurnTimeoutMs.current = IDLE_TURN_TIMEOUT_MS));
	const { runClaude, spawns } = createFakeRun(t, [[...textMessage("one"), WAIT_FOR_USER, ...textMessage("stale")], textMessage("fresh")]);
	const stream = createClaudeCodeStreamFunction(runClaude);
	const first = await runTurn(stream, [HI]);
	await waitForExit(spawns[0]!.child);
	assert.equal(textOf(await runTurn(stream, [HI, first, NEXT])), "fresh");
	assert.equal(spawns.length, 2);
});

test(`a lesson beyond ${MAX_IDLE_PROCESSES} idle ones kills the least recently used`, async (t) => {
	const { runClaude, spawns } = createFakeRun(t, [[...textMessage("one"), WAIT_FOR_USER, ...textMessage("two")]]);
	const stream = createClaudeCodeStreamFunction(runClaude);
	const sessions = Array.from({ length: MAX_IDLE_PROCESSES + 1 }, (_, index) => `lesson-${index}`);
	const firsts: AssistantMessage[] = [];
	for (const sessionId of sessions.slice(0, MAX_IDLE_PROCESSES)) firsts.push(await runTurn(stream, [HI], { sessionId }));
	// Touch lesson-0 again so lesson-1 becomes the least recently used.
	await runTurn(stream, [HI, firsts[0]!, NEXT], { sessionId: sessions[0] });
	assert.equal(spawns.length, MAX_IDLE_PROCESSES);
	await runTurn(stream, [HI], { sessionId: sessions[MAX_IDLE_PROCESSES] });
	await waitForExit(spawns[1]!.child);
	assert.deepEqual(spawns.map((spawn) => isAlive(spawn.child)), [true, false, true, true]);
});

test("killAllLiveProcesses ends idle processes and ones waiting on tool results", async (t) => {
	const readA: ToolUse = { id: "toolu_shutdown_a", name: "read", arguments: { path: "a" } };
	const idle = createFakeRun(t, [[...textMessage("one"), WAIT_FOR_USER, ...textMessage("two")]]);
	const waiting = createFakeRun(t, [[...toolUseMessage(readA), JSON.stringify({ fake: "call", ...readA }), JSON.stringify({ fake: "reply" })]]);
	const idleStream = createClaudeCodeStreamFunction(idle.runClaude);
	await runTurn(idleStream, [HI], { sessionId: "shutdown-one" });
	await runTurn(idleStream, [HI], { sessionId: "shutdown-two" });
	const toolTurn = await runTurn(createClaudeCodeStreamFunction(waiting.runClaude), [HI], { sessionId: "shutdown-three" });
	assert.equal(toolTurn.stopReason, "toolUse");
	const children = [...idle.spawns, ...waiting.spawns].map((spawn) => spawn.child);
	assert.ok(children.every(isAlive));
	killAllLiveProcesses();
	await Promise.all(children.map(waitForExit));
});

test("tool results, then a final answer, then the learner's next message all run on one process", async (t) => {
	const readA: ToolUse = { id: "toolu_keepalive_a", name: "read", arguments: { path: "a" } };
	const { runClaude, spawns } = createFakeRun(t, [[
		...toolUseMessage(readA), JSON.stringify({ fake: "call", ...readA }), JSON.stringify({ fake: "reply" }),
		WAIT_FOR_USER, ...textMessage("after the read"),
	]]);
	const stream = createClaudeCodeStreamFunction(runClaude);
	const toolTurn = await runTurn(stream, [HI]);
	const reply = await runTurn(stream, [HI, toolTurn, toToolResult(readA, "contents of a")]);
	assert.equal(textOf(reply), "contents of a");
	assert.ok(isAlive(spawns[0]!.child));
	const next = await runTurn(stream, [HI, toolTurn, toToolResult(readA, "contents of a"), reply, NEXT]);
	assert.equal(textOf(next), "after the read");
	assert.equal(spawns.length, 1);
});

test("a continued turn can call tools: admission still needs the authenticated MCP call", async (t) => {
	const readA: ToolUse = { id: "toolu_second_turn_a", name: "read", arguments: { path: "a" } };
	const { runClaude, spawns } = createFakeRun(t, [[
		...textMessage("one"), WAIT_FOR_USER,
		...toolUseMessage(readA), JSON.stringify({ fake: "call", ...readA }), JSON.stringify({ fake: "reply" }),
	]]);
	const stream = createClaudeCodeStreamFunction(runClaude);
	const first = await runTurn(stream, [HI]);
	const toolTurn = await runTurn(stream, [HI, first, NEXT]);
	assert.deepEqual(toolTurn.content.filter((block) => block.type === "toolCall").map((call) => call.id), [readA.id]);
	const reply = await runTurn(stream, [HI, first, NEXT, toolTurn, toToolResult(readA, "A")]);
	assert.equal(textOf(reply), "A");
	assert.equal(spawns.length, 1);
});

test("output the CLI produces while idle ends the process; the next message replays", async (t) => {
	const { runClaude, spawns } = createFakeRun(t, [[...textMessage("one"), ...textMessage("unrequested"), HOLD], textMessage("fresh")]);
	const stream = createClaudeCodeStreamFunction(runClaude);
	const warn = t.mock.method(console, "warn", () => {});
	const first = await runTurn(stream, [HI]);
	assert.equal(textOf(first), "one");
	await waitForExit(spawns[0]!.child);
	assert.ok(warn.mock.calls.length > 0);
	assert.equal(textOf(await runTurn(stream, [HI, first, NEXT])), "fresh");
	assert.equal(spawns.length, 2);
});

test("an MCP call made while idle is never admitted: the process ends", async (t) => {
	const readA: ToolUse = { id: "toolu_idle_call", name: "read", arguments: { path: "a" } };
	const { runClaude, spawns } = createFakeRun(t, [[...textMessage("one"), JSON.stringify({ fake: "sleep", ms: 50 }), JSON.stringify({ fake: "call", ...readA }), HOLD], textMessage("fresh")]);
	const stream = createClaudeCodeStreamFunction(runClaude);
	t.mock.method(console, "warn", () => {});
	const first = await runTurn(stream, [HI]);
	await waitForExit(spawns[0]!.child);
	const reply = await runTurn(stream, [HI, first, NEXT]);
	assert.equal(textOf(reply), "fresh");
	assert.equal(reply.content.some((block) => block.type === "toolCall"), false);
});

test("an error result after a finished message is not swallowed by the trailer hold: the process is not reused", async (t) => {
	const lines = textMessage("one").filter((line) => !line.includes("rate_limit_event") && !line.includes('"result"'));
	const resultError = JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, result: "late failure" });
	const { runClaude, spawns } = createFakeRun(t, [[...lines, resultError, WAIT_FOR_USER, ...textMessage("stale")], textMessage("fresh")]);
	const stream = createClaudeCodeStreamFunction(runClaude);
	t.mock.method(console, "warn", () => {});
	const first = await runTurn(stream, [HI]);
	await waitForExit(spawns[0]!.child);
	assert.equal(textOf(await runTurn(stream, [HI, first, NEXT])), "fresh");
	assert.equal(spawns.length, 2);
});

test("a process that dies before answering the continued message falls back to a fresh replay", async (t) => {
	const { runClaude, spawns } = createFakeRun(t, [[...textMessage("one"), WAIT_FOR_USER, JSON.stringify({ fake: "exit", code: 1, stderr: "" })], textMessage("fresh")]);
	const stream = createClaudeCodeStreamFunction(runClaude);
	t.mock.method(console, "error", () => {});
	const first = await runTurn(stream, [HI]);
	const reply = await runTurn(stream, [HI, first, NEXT]);
	assert.equal(textOf(reply), "fresh");
	assert.equal(spawns.length, 2);
	const [replay] = userLines(spawns[1]!);
	assert.ok(replay?.includes("and then?") && replay.includes("[assistant]\\none"), replay);
});

test("the native-only message cap counts per turn on a reused process", async (t) => {
	t.mock.method(console, "warn", () => {});
	const natives = (turn: number) => [0, 1, 2].flatMap((index) => nativeOnlyMessage(`toolu_native_${turn}_${index}`));
	const { runClaude, spawns } = createFakeRun(t, [[...natives(1), ...textMessage("one"), WAIT_FOR_USER, ...natives(2), ...textMessage("two")]]);
	const stream = createClaudeCodeStreamFunction(runClaude);
	const first = await runTurn(stream, [HI]);
	const second = await runTurn(stream, [HI, first, NEXT]);
	assert.equal(textOf(second), "two");
	assert.equal(spawns.length, 1);
});

test("aborting a continued turn kills the process; the next message replays", async (t) => {
	const { runClaude, spawns } = createFakeRun(t, [[...textMessage("one"), WAIT_FOR_USER, streamEvent({ type: "message_start", message: { usage: {} } }), HOLD], textMessage("fresh")]);
	const stream = createClaudeCodeStreamFunction(runClaude);
	const first = await runTurn(stream, [HI]);
	const controller = new AbortController();
	const context = normalizeContext({ systemPrompt: "You are a tutor.", messages: [HI, first, NEXT], tools: [READ_TOOL] });
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream(getModel(), context, { sessionId: SESSION_ID, signal: controller.signal })) {
		events.push(event);
		if (event.type === "start") controller.abort();
	}
	assert.equal(events.at(-1)?.type, "error");
	await waitForExit(spawns[0]!.child);
	assert.equal(textOf(await runTurn(stream, [HI, first, NEXT])), "fresh");
});

test("aborting a finished turn's signal later does not kill the idle process", async (t) => {
	const { runClaude, spawns } = createFakeRun(t, [[...textMessage("one"), WAIT_FOR_USER, ...textMessage("two")]]);
	const stream = createClaudeCodeStreamFunction(runClaude);
	const controller = new AbortController();
	const first = await runTurn(stream, [HI], { signal: controller.signal });
	controller.abort();
	await sleep(50);
	assert.ok(isAlive(spawns[0]!.child));
	assert.equal(textOf(await runTurn(stream, [HI, first, NEXT])), "two");
	assert.equal(spawns.length, 1);
});

test("two lessons each keep their own process", async (t) => {
	const { runClaude, spawns } = createFakeRun(t, [[...textMessage("one"), WAIT_FOR_USER, ...textMessage("two")]]);
	const stream = createClaudeCodeStreamFunction(runClaude);
	const a = await runTurn(stream, [HI], { sessionId: "lesson-a" });
	const b = await runTurn(stream, [HI], { sessionId: "lesson-b" });
	assert.equal(textOf(await runTurn(stream, [HI, b, NEXT], { sessionId: "lesson-b" })), "two");
	assert.equal(textOf(await runTurn(stream, [HI, a, NEXT], { sessionId: "lesson-a" })), "two");
	assert.equal(spawns.length, 2);
});

test("endLiveSession ends a finished job's kept process (sub-agents send no next message)", async (t) => {
	const { runClaude, spawns } = createFakeRun(t, [[...textMessage("one"), WAIT_FOR_USER, ...textMessage("two")]]);
	await runTurn(createClaudeCodeStreamFunction(runClaude), [HI], { sessionId: "job-run" });
	assert.ok(isAlive(spawns[0]!.child));
	endLiveSession("job-run");
	await waitForExit(spawns[0]!.child);
});

test("a lesson's newer process supersedes one an earlier module copy kept (dev reload), whatever its owner", (t) => {
	t.after(() => killAllLiveProcesses());
	const killed: string[] = [];
	const fake = (name: string, sessionId: string) => ({ owner: Symbol(name), sessionId, kill: () => killed.push(name) });
	addIdleProcess(fake("before reload, idle", "reloaded-lesson"));
	addLiveProcess(fake("before reload, waiting", "other-lesson"));
	addIdleProcess(fake("after reload", "reloaded-lesson"));
	assert.deepEqual([...killed], ["before reload, idle"]);
	addLiveProcess(fake("after reload, waiting", "other-lesson"));
	assert.deepEqual([...killed], ["before reload, idle", "before reload, waiting"]);
});

test("a process whose CLI compacted its own conversation is not kept: the next message replays", async (t) => {
	// The CLI's auto-compaction rewrites the lesson it holds, so it no longer matches the snapshot.
	const compacted = JSON.stringify({ type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto", pre_tokens: 180000 } });
	const { runClaude, spawns } = createFakeRun(t, [[compacted, ...textMessage("one"), WAIT_FOR_USER, ...textMessage("stale")], textMessage("fresh")]);
	const stream = createClaudeCodeStreamFunction(runClaude);
	const first = await runTurn(stream, [HI]);
	assert.equal(textOf(first), "one");
	await waitForExit(spawns[0]!.child);
	assert.equal(textOf(await runTurn(stream, [HI, first, NEXT])), "fresh");
	assert.equal(spawns.length, 2);
});
