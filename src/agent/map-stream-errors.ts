import { createAssistantMessageEventStream, type AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";

import { cliErrorMessage } from "../core/cli-errors.ts";

/**
 * Re-emits a provider stream with each failure's errorMessage run through the
 * shared error vocabulary, so the API backend shows the same sentences as the
 * Claude Code CLI one. Every other event passes through untouched.
 */
export function mapStreamErrors(source: AssistantMessageEventStream): AssistantMessageEventStream {
	const mapped = createAssistantMessageEventStream();
	void (async () => {
		try {
			for await (const event of source) {
				if (event.type === "error" && typeof event.error.errorMessage === "string") {
					mapped.push({ ...event, error: { ...event.error, errorMessage: cliErrorMessage(event.error.errorMessage) } });
				} else {
					mapped.push(event);
				}
			}
		} finally {
			mapped.end();
		}
	})();
	return mapped;
}
