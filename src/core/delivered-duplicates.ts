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
 *
 * ONE EXCEPTION, for messages still streaming (`opts.inFlight`): a partial
 * text block is hidden while it is a non-empty PREFIX of a delivered
 * same-turn message. Without it a lesson-length repeat would stream in as a
 * second copy for the whole generation and vanish at the final delta. There
 * is no minimum prefix length: any minimum would let its first characters
 * flash in and then disappear, which is the very flicker being avoided. The
 * cost is that streamed text which happens to start like the delivered
 * message stays hidden until it diverges (then it appears whole) or the
 * message settles (strict equality applies again). Settled messages never
 * use the prefix rule.
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

/** The hidden blocks as a set of `deliveryKey`s that also remembers them
 *  per message, so consumers never have to parse a key back apart. */
export class DuplicateDeliveryKeys extends Set<string> {
	private readonly byMessage = new Map<string, Set<number>>();

	record(messageId: string, contentIndex: number): void {
		this.add(deliveryKey(messageId, contentIndex));
		let indexes = this.byMessage.get(messageId);
		if (!indexes) this.byMessage.set(messageId, (indexes = new Set()));
		indexes.add(contentIndex);
	}

	indexesOf(messageId: string): ReadonlySet<number> | undefined {
		return this.byMessage.get(messageId);
	}
}

export interface DuplicateDeliveryOptions {
	/** Ids of messages still streaming (projectView's live.streamingIds):
	 *  their text blocks are also hidden while a prefix of a delivered message. */
	inFlight?: ReadonlySet<string>;
}

/** Keys of assistant `text` blocks that repeat, verbatim up to whitespace,
 *  a send_to_user message delivered earlier in the same turn. */
export function duplicateDeliveryKeys(messages: readonly LhMessage[], opts: DuplicateDeliveryOptions = {}): DuplicateDeliveryKeys {
	const hidden = new DuplicateDeliveryKeys();
	const failed = failedOutputCallIds(messages);
	let delivered = new Set<string>(); // normalized send_to_user messages of the current turn
	for (const message of messages) {
		if (message.role === "user") {
			delivered = new Set();
			continue;
		}
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		const streaming = opts.inFlight?.has(message.id) === true;
		for (const [contentIndex, block] of message.content.entries()) {
			if (!block || typeof block !== "object") continue;
			if (block.type === "toolCall") {
				if (failed.has(block.id)) continue;
				const sent = sendToUserText(block);
				if (sent !== undefined) delivered.add(normalized(sent));
			} else if (block.type === "text" && typeof block.text === "string" && delivered.size > 0) {
				const text = normalized(block.text);
				if (text === "") continue;
				if (delivered.has(text) || (streaming && [...delivered].some((sent) => sent.startsWith(text)))) {
					hidden.record(message.id, contentIndex);
				}
			}
		}
	}
	return hidden;
}

/** The content indexes of ONE message hidden by `keys` (undefined when none),
 *  in the shape userFacingTextOf takes. */
export function hiddenIndexesOf(message: Pick<LhMessage, "id">, keys: DuplicateDeliveryKeys): ReadonlySet<number> | undefined {
	return keys.indexesOf(message.id);
}
