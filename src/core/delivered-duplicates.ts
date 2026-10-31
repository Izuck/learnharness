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
 *    a summary, a prefix or a superset is NOT a duplicate and stays visible
 *    (the one exception is the message that is streaming right now, below);
 *  - the call must be EARLIER than the text (an earlier message, or an
 *    earlier block of the same message) and in the same turn, where a turn
 *    starts at each `user` message (custom markers are not boundaries);
 *  - the call must be delivered: calls in failedOutputCallIds (error result,
 *    or an errored/aborted generation) are retry context, so their text twin
 *    is the only copy the learner gets and stays visible.
 *
 * THE STREAMING EXCEPTION (`opts.inFlight`): the lesson view passes the id of
 * the ONE message that is streaming right now. A non-empty text block of that
 * message is also hidden while it is a PREFIX of a delivered same-turn
 * message. Without it a lesson-length repeat would stream in as a second copy
 * for the whole generation and vanish at the final delta. There is no minimum
 * prefix length: any minimum would let its first characters flash in and then
 * disappear, which is the very flicker being avoided. The cost is that
 * streamed text which happens to start like the delivered message stays
 * hidden until it diverges (then it appears whole) or its message settles
 * (strict equality applies again). Every other message, including messages
 * that settled earlier in the same streaming session, uses strict equality;
 * so do all non-view readers, which never pass `inFlight`.
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

/** The hidden blocks of a transcript: read-only, built only by
 *  `duplicateDeliveryKeys`. Answers by key (`has`, iteration, `size`) and by
 *  message (`indexesOf`), so consumers never parse a key back apart. */
export class DuplicateDeliveryKeys {
	readonly #byMessage: ReadonlyMap<string, ReadonlySet<number>>;

	constructor(byMessage: ReadonlyMap<string, ReadonlySet<number>>) {
		this.#byMessage = byMessage;
	}

	get size(): number {
		let n = 0;
		for (const indexes of this.#byMessage.values()) n += indexes.size;
		return n;
	}

	has(key: string): boolean {
		for (const [messageId, indexes] of this.#byMessage) {
			for (const index of indexes) if (deliveryKey(messageId, index) === key) return true;
		}
		return false;
	}

	*keys(): IterableIterator<string> {
		for (const [messageId, indexes] of this.#byMessage) {
			for (const index of indexes) yield deliveryKey(messageId, index);
		}
	}

	[Symbol.iterator](): IterableIterator<string> {
		return this.keys();
	}

	/** The content indexes of ONE message that are hidden (undefined when none),
	 *  in the shape userFacingTextOf takes. */
	indexesOf(messageId: string): ReadonlySet<number> | undefined {
		return this.#byMessage.get(messageId);
	}
}

export interface DuplicateDeliveryOptions {
	/** Ids of the message(s) streaming RIGHT NOW (the lesson view only):
	 *  see "the streaming exception" in the file header. NOT the consume-scoped
	 *  streamingIds, which keeps messages that already settled. */
	inFlight?: ReadonlySet<string>;
}

/** Text blocks that repeat, verbatim up to whitespace, a send_to_user message
 *  delivered earlier in the same turn. */
export function duplicateDeliveryKeys(messages: readonly LhMessage[], opts: DuplicateDeliveryOptions = {}): DuplicateDeliveryKeys {
	const hidden = new Map<string, Set<number>>();
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
					let indexes = hidden.get(message.id);
					if (!indexes) hidden.set(message.id, (indexes = new Set()));
					indexes.add(contentIndex);
				}
			}
		}
	}
	return new DuplicateDeliveryKeys(hidden);
}

/** The content indexes of ONE message hidden by `keys` (undefined when none). */
export function hiddenIndexesOf(message: Pick<LhMessage, "id">, keys: DuplicateDeliveryKeys): ReadonlySet<number> | undefined {
	return keys.indexesOf(message.id);
}
