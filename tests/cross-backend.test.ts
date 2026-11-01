/**
 * Thinking produced on one Anthropic backend (Claude Code CLI or the API) is dropped when the
 * history is sent to the other, instead of being resent as plain assistant text.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeContext, type AssistantMessage, type Message, type ToolResultMessage } from "@earendil-works/pi-ai";
import { stripForeignThinking } from "../src/core/cross-backend.ts";
import { piEngineForSpec, piModels } from "../src/agent/models.ts";
import { createClaudeCodeProvider } from "../src/agent/claude-code/provider.ts";
import { streamClaudeCode } from "../src/agent/claude-code/stream.ts";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { conversationForReuse } from "../src/agent/claude-code/reuse-context.ts";

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function assistant(provider: string, content: AssistantMessage["content"]): AssistantMessage {
	return { role: "assistant", content, api: provider === "anthropic" ? "anthropic-messages" : "claude-code-cli", provider, model: "opus", usage, stopReason: "stop", timestamp: 1 };
}

const THINK = "SECRET-REASONING-NOTES";

function history(provider: string): Message[] {
	const result: ToolResultMessage = { role: "toolResult", toolCallId: "t1", toolName: "read", content: [{ type: "text", text: "file body" }], isError: false, timestamp: 3 };
	return [
		{ role: "user", content: "hello", timestamp: 0 },
		assistant(provider, [
			{ type: "thinking", thinking: THINK, thinkingSignature: provider === "anthropic" ? "sig" : undefined },
			{ type: "text", text: "answer" },
			{ type: "toolCall", id: "t1", name: "read", arguments: { path: "a" } },
		]),
		result,
	];
}

describe("stripForeignThinking", () => {
	it("drops thinking from a claude-code message when the target is anthropic, keeping text", () => {
		const out = stripForeignThinking(history("claude-code"), { provider: "anthropic" });
		const a = out[1] as AssistantMessage;
		assert.deepEqual(a.content.map((b) => b.type), ["text", "toolCall"]);
		assert.equal((a.content[0] as { text: string }).text, "answer");
	});

	it("drops API thinking when the target is claude-code", () => {
		const out = stripForeignThinking(history("anthropic"), { provider: "claude-code" });
		assert.ok(!JSON.stringify(out).includes(THINK));
	});

	it("leaves a same-provider message unchanged", () => {
		const input = history("anthropic");
		const out = stripForeignThinking(input, { provider: "anthropic" });
		assert.deepEqual(out, input);
		assert.ok((out[1] as AssistantMessage).content.some((b) => b.type === "thinking"));
	});

	it("keeps tool calls, tool results and user messages", () => {
		const input = history("claude-code");
		const out = stripForeignThinking(input, { provider: "anthropic" });
		assert.equal(out.length, 3);
		assert.deepEqual(out[0], input[0]);
		assert.deepEqual(out[2], input[2]);
		assert.deepEqual((out[1] as AssistantMessage).content[1], { type: "toolCall", id: "t1", name: "read", arguments: { path: "a" } });
	});

	it("never mutates the input", () => {
		const input = history("claude-code");
		const copy = structuredClone(input);
		stripForeignThinking(input, { provider: "anthropic" });
		assert.deepEqual(input, copy);
	});

	it("is deterministic, so a live-process continuation still matches the stored history", () => {
		const a = conversationForReuse(stripForeignThinking(history("anthropic"), { provider: "claude-code" }));
		const b = conversationForReuse(stripForeignThinking(history("anthropic"), { provider: "claude-code" }));
		assert.deepEqual(a, b);
	});
});

describe("the engine boundary", () => {
	it("sends a claude-code lesson's thinking to the Anthropic API as nothing, not as text", async () => {
		const previousKey = process.env.ANTHROPIC_API_KEY;
		const realFetch = globalThis.fetch;
		process.env.ANTHROPIC_API_KEY = "dummy-cross-backend-key";
		let body = "";
		globalThis.fetch = async (input, init) => {
			body = await new Request(input, init).text();
			throw new Error("CLOSED: request captured");
		};
		try {
			const engine = piEngineForSpec({ provider: "anthropic", id: "claude-haiku-4-5", thinkingLevel: "high" });
			const context = normalizeContext({ systemPrompt: "sys", messages: [...history("claude-code"), { role: "user", content: "next", timestamp: 4 }] });
			await engine.streamFn(engine.model, context, {}).result();
			assert.ok(body.includes("answer"), "the request was captured");
			assert.ok(!body.includes(THINK), "foreign thinking never reaches the wire");
		} finally {
			globalThis.fetch = realFetch;
			if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = previousKey;
		}
	});

	it("sends an API lesson to the Claude Code CLI stream without the API thinking", async () => {
		const seen: Message[][] = [];
		piModels().setProvider(createClaudeCodeProvider((model, context) => {
			seen.push(context.messages);
			const stream = createAssistantMessageEventStream();
			stream.push({ type: "done", reason: "stop", message: assistant("claude-code", [{ type: "text", text: "ok" }]) });
			stream.end();
			return stream;
		}));
		try {
			const engine = piEngineForSpec({ provider: "claude-code", id: "opus", thinkingLevel: "high" });
			const context = normalizeContext({ systemPrompt: "sys", messages: [...history("anthropic"), { role: "user", content: "next", timestamp: 4 }] });
			await engine.streamFn(engine.model, context, {}).result();
			assert.equal(seen.length, 1);
			assert.ok(!JSON.stringify(seen[0]).includes(THINK), "foreign thinking never reaches the CLI stream");
			assert.ok(JSON.stringify(seen[0]).includes("answer"), "the visible text still does");
		} finally {
			piModels().setProvider(createClaudeCodeProvider(streamClaudeCode));
		}
	});
});
