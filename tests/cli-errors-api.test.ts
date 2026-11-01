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

test("API stream errors that are not recognised pass through unchanged", async () => {
	const source = createAssistantMessageEventStream();
	const mapped = mapStreamErrors(source);
	source.push({ type: "error", reason: "error", error: failed("socket hang up") });
	source.end();
	assert.equal((await mapped.result()).errorMessage, "socket hang up");
});
