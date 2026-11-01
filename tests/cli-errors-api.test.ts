import assert from "node:assert/strict";
import test from "node:test";

import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import type { AssistantMessage } from "@earendil-works/pi-ai";

import { mapStreamErrors } from "../src/agent/map-stream-errors.ts";

function failed(errorMessage: string): AssistantMessage {
	return {
		role: "assistant", content: [], api: "anthropic-messages", provider: "anthropic", model: "m", stopReason: "error", errorMessage, timestamp: 0,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	};
}

test("API stream errors are rewritten through the shared vocabulary, in events and in the final result", async () => {
	const source = createAssistantMessageEventStream();
	const mapped = mapStreamErrors(source);
	source.push({ type: "error", reason: "error", error: failed('529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}') });
	source.end();
	const events = [];
	for await (const event of mapped) events.push(event);
	assert.equal(events.length, 1);
	assert.equal(events[0]!.type === "error" && events[0]!.error.errorMessage, "Claude is busy right now. Try again in a moment.");
	assert.equal((await mapped.result()).errorMessage, "Claude is busy right now. Try again in a moment.");
});

test("an API 401 says the key was rejected, not that Claude Code is signed out", async () => {
	const source = createAssistantMessageEventStream();
	const mapped = mapStreamErrors(source);
	source.push({ type: "error", reason: "error", error: failed('401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}') });
	source.end();
	assert.equal((await mapped.result()).errorMessage, "Your Anthropic API key was rejected. Check it in Settings → Keys.");
});

test("API stream errors that are not recognised pass through unchanged", async () => {
	const source = createAssistantMessageEventStream();
	const mapped = mapStreamErrors(source);
	source.push({ type: "error", reason: "error", error: failed("socket hang up") });
	source.end();
	assert.equal((await mapped.result()).errorMessage, "socket hang up");
});

test("a source that throws mid-stream ends the mapped stream with an error event, never hanging", async () => {
	const unhandled: unknown[] = [];
	const onUnhandled = (reason: unknown) => unhandled.push(reason);
	process.on("unhandledRejection", onUnhandled);
	try {
		const partial = failed("");
		const source = {
			async *[Symbol.asyncIterator]() {
				yield { type: "start" as const, partial };
				throw new Error('529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}');
			},
		};
		const mapped = mapStreamErrors(source as never);
		const events = [];
		for await (const event of mapped) events.push(event);
		assert.deepEqual(events.map((event) => event.type), ["start", "error"]);
		const last = events.at(-1)!;
		assert.equal(last.type === "error" && last.error.errorMessage, "Claude is busy right now. Try again in a moment.");
		assert.equal(last.type === "error" && last.error.stopReason, "error");
		assert.equal((await mapped.result()).errorMessage, "Claude is busy right now. Try again in a moment.");
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepEqual(unhandled, []);
	} finally {
		process.off("unhandledRejection", onUnhandled);
	}
});

test("a source that throws before any event still yields a usable error result", async () => {
	const source = { async *[Symbol.asyncIterator]() { throw new Error("socket hang up"); } };
	const mapped = mapStreamErrors(source as never);
	const result = await mapped.result();
	assert.equal(result.stopReason, "error");
	assert.equal(result.errorMessage, "socket hang up");
});
