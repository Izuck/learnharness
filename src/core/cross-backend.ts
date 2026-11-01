/**
 * CROSS-BACKEND HISTORY (forest spec H): the app reaches Claude through two backends - the Claude
 * Code CLI (provider `claude-code`, which drops thinking signatures) and the Anthropic API
 * (provider `anthropic`, signed thinking). A lesson can move between them mid-way, and unsigned
 * thinking sent to the API is turned into plain assistant text (or flattened into the CLI's
 * text replay), so the model would read its own old reasoning as something it said aloud.
 * This drops thinking the target backend did not produce. Pure and browser-safe; the one call
 * site is the engine's stream function (src/agent/models.ts), which every agent runs on.
 */

import type { AssistantMessage, Message } from "@earendil-works/pi-ai";

/** Remove `thinking` blocks from assistant messages whose `provider` is not the target's.
 *  Everything else is returned as-is; the input is never mutated, and messages with nothing
 *  to drop keep their identity so the result is deterministic across calls. */
export function stripForeignThinking(messages: Message[], target: { provider: string }): Message[] {
	return messages.map((message) => {
		if (message.role !== "assistant" || message.provider === target.provider) return message;
		if (!message.content.some((block) => block.type === "thinking")) return message;
		const stripped: AssistantMessage = { ...message, content: message.content.filter((block) => block.type !== "thinking") };
		return stripped;
	});
}
