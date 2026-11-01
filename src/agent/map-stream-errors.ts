import { createAssistantMessageEventStream, type AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";

import { cliErrorMessage } from "../core/cli-errors.ts";

const emptyUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

/**
 * Re-emits an Anthropic API stream with each failure's errorMessage run through the shared
 * error vocabulary, so the API backend shows the same sentences as the Claude Code CLI one.
 * Every other event passes through untouched. A source that throws instead of emitting an
 * error event still ends the mapped stream with one, so `result()` never hangs.
 */
export function mapStreamErrors(source: AsyncIterable<AssistantMessageEvent>): AssistantMessageEventStream {
	const mapped = createAssistantMessageEventStream();
	void (async () => {
		let partial: AssistantMessage | undefined;
		let settled = false;
		try {
			for await (const event of source) {
				if ("partial" in event) partial = event.partial;
				if (event.type === "done" || event.type === "error") settled = true;
				if (event.type === "error" && typeof event.error.errorMessage === "string") {
					mapped.push({ ...event, error: { ...event.error, errorMessage: cliErrorMessage(event.error.errorMessage, "anthropic") } });
				} else {
					mapped.push(event);
				}
			}
		} catch (error) {
			if (!settled) {
				const raw = error instanceof Error ? error.message : String(error);
				const failure: AssistantMessage = {
					...(partial ?? { role: "assistant", content: [], api: "", provider: "", model: "", usage: emptyUsage, timestamp: Date.now() }),
					stopReason: "error",
					errorMessage: cliErrorMessage(raw, "anthropic"),
				};
				mapped.push({ type: "error", reason: "error", error: failure });
			}
		} finally {
			mapped.end();
		}
	})();
	return mapped;
}
