/**
 * Delivered duplicates: a Claude model sometimes delivers a message with
 * send_to_user and then, later in the SAME turn, repeats the exact same
 * text as an ordinary assistant text block. Both are learner-facing prose,
 * so the learner would read it twice. This pure module finds those repeats
 * so every learner-facing reader (lesson view, Markdown export, extraction
 * view, coverage) can drop them consistently.
 *
 * LEARNER-FACING ONLY: the native record and the model-facing history
 * (toLlmMessages) are never touched; the model still sees what it wrote.
 *
 * The rule is deliberately narrow, so nothing real is ever hidden:
 *  - exact equality after trimming and collapsing whitespace runs; a recap,
 *    a summary, a prefix or a superset is NOT a duplicate and stays visible;
 *  - the call must be EARLIER than the text (an earlier message, or an
 *    earlier block of the same message) and in the same turn, where a turn
 *    starts at each `user` message (custom markers are not boundaries);
 *  - the call must be delivered: calls in failedOutputCallIds (error result,
 *    or an errored/aborted generation) are retry context, so their text twin
 *    is the only copy the learner gets and stays visible.
 */

import { failedOutputCallIds, sendToUserText, type LhMessage } from "./native-messages.ts";

/** Trim and collapse every whitespace run to one space. */
function normalized(text: string): string {
	return text.trim().replace(/\s+/g, " ");
}

/** The identity of one assistant content block: `${messageId}:${contentIndex}`
 *  (contentIndex indexes the message's own `content` array). */
export function deliveryKey(messageId: string, contentIndex: number): string {
	return `${messageId}:${contentIndex}`;
}

/** Keys of assistant `text` blocks that repeat, verbatim up to whitespace,
 *  a send_to_user message delivered earlier in the same turn. */
export function duplicateDeliveryKeys(messages: readonly LhMessage[]): ReadonlySet<string> {
	const hidden = new Set<string>();
	const failed = failedOutputCallIds(messages);
	let delivered = new Set<string>(); // normalized send_to_user messages of the current turn
	for (const message of messages) {
		if (message.role === "user") {
			delivered = new Set();
			continue;
		}
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const [contentIndex, block] of message.content.entries()) {
			if (!block || typeof block !== "object") continue;
			if (block.type === "toolCall") {
				if (failed.has(block.id)) continue;
				const sent = sendToUserText(block);
				if (sent !== undefined) delivered.add(normalized(sent));
			} else if (block.type === "text" && typeof block.text === "string" && delivered.size > 0) {
				const text = normalized(block.text);
				if (text !== "" && delivered.has(text)) hidden.add(deliveryKey(message.id, contentIndex));
			}
		}
	}
	return hidden;
}

/** The content indexes of ONE message hidden by `keys` (undefined when none),
 *  in the shape userFacingTextOf takes. */
export function hiddenIndexesOf(message: Pick<LhMessage, "id">, keys: ReadonlySet<string>): ReadonlySet<number> | undefined {
	if (keys.size === 0) return undefined;
	const prefix = `${message.id}:`;
	let out: Set<number> | undefined;
	for (const key of keys) {
		if (!key.startsWith(prefix)) continue;
		const index = Number(key.slice(prefix.length));
		if (Number.isInteger(index)) (out ??= new Set()).add(index);
	}
	return out;
}
