/**
 * Delivered duplicates (core/delivered-duplicates.ts): Opus sometimes calls
 * send_to_user and then repeats the exact same text as an ordinary text
 * block later in the same turn. The learner must see it once. Pinned here:
 * the pure detector (turn boundary, failed calls, normalization, exact
 * equality only) and each learner-facing consumer (lesson view, Markdown,
 * extraction view, coverage). Model-facing history is never touched.
 * Synthetic fixtures only, shaped like a real record's indices 35-37.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import type { LhMessage } from "../src/core/native-messages.ts";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-dup-"));
const originalEnv = process.env;
process.env = {
	...(originalEnv.NODE_TEST_CONTEXT ? { NODE_TEST_CONTEXT: originalEnv.NODE_TEST_CONTEXT } : {}),
	...(originalEnv.NODE_OPTIONS ? { NODE_OPTIONS: originalEnv.NODE_OPTIONS } : {}),
	NODE_ENV: "test",
	LH_DATA_DIR: path.join(scratch, "data"),
	LH_AUTH_FILE: path.join(scratch, "auth.json"),
	HOME: path.join(scratch, "home"),
};
after(() => {
	process.env = originalEnv;
	fs.rmSync(scratch, { recursive: true, force: true });
});

const { duplicateDeliveryKeys } = await import("../src/core/delivered-duplicates.ts");
const { SEND_TO_USER_TOOL, toLlmMessages } = await import("../src/core/native-messages.ts");
const { projectView } = await import("../src/core/view.ts");
const { sessionMarkdown } = await import("../src/core/session-markdown.ts");
const { coverageOf, coverageSlots, messageFingerprint, messageViewLines, teacherProseBlocks } = await import("../src/core/coverage.ts");
const { transcriptView } = await import("../src/agent/subagents/extraction.ts");
const { chatStore } = await import("../src/store/chats.ts");

const LESSON = "Here is what we will cover.\n\nThe plan:\n\n1. Limits\n2. Derivatives";

function user(id: string, text = "go"): LhMessage {
	return { id, role: "user", content: text, timestamp: 1 } as never;
}
function marker(id: string): LhMessage {
	return { id, role: "custom", customType: "probe-handoff", content: "x", display: true, details: null, timestamp: 1 } as never;
}
function assistant(id: string, content: unknown[], stopReason = "stop"): LhMessage {
	return {
		id, role: "assistant", content, api: "claude-code-cli", provider: "claude-code", model: "opus",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason, timestamp: 1,
	} as never;
}
const send = (message: unknown, id = "send-1") => ({ type: "toolCall", id, name: SEND_TO_USER_TOOL, arguments: { message } });
const text = (t: string) => ({ type: "text", text: t });
function ack(callId = "send-1", isError = false): LhMessage {
	return {
		id: `ack-${callId}`, role: "toolResult", toolCallId: callId, toolName: SEND_TO_USER_TOOL,
		content: [{ type: "text", text: isError ? "Invalid tool input" : "Message received for display." }],
		details: null, isError, timestamp: 1,
	} as never;
}

/** The real record's pattern (indices 35-37): call, ack, then the same text. */
function realShape(dupText = LESSON): LhMessage[] {
	return [user("u1"), assistant("m35", [send(LESSON)], "toolUse"), ack(), assistant("m37", [text(dupText)])];
}
function viewProse(messages: LhMessage[]): string[] {
	return projectView(messages).filter((m) => m.role === "assistant").flatMap((m) => m.parts.filter((p) => p.type === "text").map((p) => p.text!));
}

describe("duplicateDeliveryKeys", () => {
	it("hides an exact duplicate in a later message of the same turn (real record shape)", () => {
		assert.deepEqual([...duplicateDeliveryKeys(realShape())], ["m37:0"]);
	});

	it("hides a text block after the call in the SAME assistant message, not one before it", () => {
		const later = [user("u1"), assistant("a1", [send(LESSON), text(LESSON)]), ack()];
		assert.deepEqual([...duplicateDeliveryKeys(later)], ["a1:1"]);
		const earlier = [user("u1"), assistant("a1", [text(LESSON), send(LESSON)]), ack()];
		assert.equal(duplicateDeliveryKeys(earlier).size, 0, "text before the call is the original, not a repeat");
	});

	it("keys by contentIndex and leaves other blocks of the message alone", () => {
		const messages = [user("u1"), assistant("a1", [send(LESSON)], "toolUse"), ack(), assistant("a2", [{ type: "thinking", thinking: "t" }, text("Different."), text(LESSON)])];
		assert.deepEqual([...duplicateDeliveryKeys(messages)], ["a2:2"]);
	});

	it("ignores whitespace-only differences", () => {
		const spaced = "  Here is   what we will cover.\n\n\n The plan:\t\n\n1. Limits\n2.  Derivatives \n";
		assert.deepEqual([...duplicateDeliveryKeys(realShape(spaced))], ["m37:0"]);
	});

	it("never hides a different recap, a prefix, or a superset", () => {
		assert.equal(duplicateDeliveryKeys(realShape("Short recap of the plan.")).size, 0);
		assert.equal(duplicateDeliveryKeys(realShape(LESSON.slice(0, 40))).size, 0);
		assert.equal(duplicateDeliveryKeys(realShape(`${LESSON}\n\nAnything else?`)).size, 0);
	});

	it("a duplicate of a PREVIOUS turn's send_to_user is shown (a user message is the boundary)", () => {
		const messages = [user("u1"), assistant("a1", [send(LESSON)], "toolUse"), ack(), user("u2", "ok"), assistant("a2", [text(LESSON)])];
		assert.equal(duplicateDeliveryKeys(messages).size, 0);
	});

	it("custom markers are not turn boundaries", () => {
		const messages = [user("u1"), assistant("a1", [send(LESSON)], "toolUse"), ack(), marker("k1"), assistant("a2", [text(LESSON)])];
		assert.deepEqual([...duplicateDeliveryKeys(messages)], ["a2:0"]);
	});

	it("a failed send_to_user (error result or errored generation) leaves the text duplicate visible", () => {
		const failedResult = [user("u1"), assistant("a1", [send(LESSON)], "toolUse"), ack("send-1", true), assistant("a2", [text(LESSON)])];
		assert.equal(duplicateDeliveryKeys(failedResult).size, 0);
		const aborted = [user("u1"), assistant("a1", [send(LESSON)], "aborted"), assistant("a2", [text(LESSON)])];
		assert.equal(duplicateDeliveryKeys(aborted).size, 0);
	});

	it("only a call EARLIER than the text counts; blank/malformed messages carry nothing", () => {
		const callAfter = [user("u1"), assistant("a1", [text(LESSON)]), assistant("a2", [send(LESSON)], "toolUse"), ack()];
		assert.equal(duplicateDeliveryKeys(callAfter).size, 0);
		const blank = [user("u1"), assistant("a1", [send("  \n ")], "toolUse"), ack(), assistant("a2", [text("  ")])];
		assert.equal(duplicateDeliveryKeys(blank).size, 0);
		assert.equal(duplicateDeliveryKeys([user("u1"), assistant("a1", [send(7)], "toolUse"), ack(), assistant("a2", [text("7")])]).size, 0);
	});

	it("covers several calls in one turn", () => {
		const messages = [user("u1"), assistant("a1", [send("One."), send("Two.", "send-2")], "toolUse"), ack(), ack("send-2"), assistant("a2", [text("Two."), text("Three."), text("One.")])];
		assert.deepEqual([...duplicateDeliveryKeys(messages)].sort(), ["a2:0", "a2:2"]);
	});
});

describe("consumers drop the duplicate; the model-facing history keeps it", () => {
	it("lesson view: shows the lesson once (real record shape), a different recap twice", () => {
		assert.deepEqual(viewProse(realShape()), [LESSON]);
		assert.deepEqual(viewProse(realShape("Short recap.")), [LESSON, "Short recap."]);
		const sameMessage = [user("u1"), assistant("a1", [send(LESSON), text(LESSON)], "toolUse"), ack()];
		assert.deepEqual(viewProse(sameMessage), [LESSON]);
	});

	it("lesson view: a message whose only block is the duplicate adds no step", () => {
		const view = projectView(realShape());
		assert.equal(view.filter((m) => m.role === "assistant").length, 1);
		assert.equal(view.flatMap((m) => m.parts).filter((p) => p.type === "step-start").length, 1);
	});

	it("lesson view: a failed call keeps the text and shows the call as its error card", () => {
		const messages = [user("u1"), assistant("a1", [send(LESSON)], "toolUse"), ack("send-1", true), assistant("a2", [text(LESSON)])];
		assert.deepEqual(viewProse(messages), [LESSON]);
	});

	it("lesson view: previous-turn duplicate stays visible", () => {
		const messages = [user("u1"), assistant("a1", [send(LESSON)], "toolUse"), ack(), user("u2"), assistant("a2", [text(LESSON)])];
		assert.deepEqual(viewProse(messages), [LESSON, LESSON]);
	});

	it("markdown export: message 37's text is not exported twice", () => {
		const md = sessionMarkdown(realShape(), { anchors: false });
		assert.equal(md.split(LESSON).length - 1, 1);
		assert.equal(md, `### Learner\n\ngo\n\n### Teacher\n\n${LESSON}`);
		const recap = sessionMarkdown(realShape("Short recap."), { anchors: false });
		assert.ok(recap.includes("Short recap."));
	});

	it("extraction view and teacher prose: the duplicate is extracted once", () => {
		const messages = realShape();
		const record = chatStore.createChat("Dup fixture");
		assert.equal(transcriptView({ ...record, messages }), `# Dup fixture\n\nTEACHER [m35] ${LESSON}`);
		assert.deepEqual(teacherProseBlocks(messages), [LESSON]);
		assert.deepEqual(teacherProseBlocks(realShape("Short recap.")), [LESSON, "Short recap."]);
	});

	it("coverage: the hidden block contributes no text; a duplicate-only message becomes invisible", () => {
		const messages = realShape();
		const slots = coverageSlots(messages);
		assert.equal(slots.find((s) => s.message.id === "m37")!.tokens, 0);
		assert.ok(slots.find((s) => s.message.id === "m35")!.tokens > 0);
		assert.equal(coverageOf(messages, [], "fixture").uncoveredCount, 1);
		// Transcripts without a duplicate keep byte-identical fingerprints.
		const plain = [user("u1"), assistant("p1", [text("Plain.")])];
		assert.equal(coverageSlots(plain)[1]!.fp, messageFingerprint(plain[1]!), "no-duplicate fingerprints are unchanged");
		// The message-level helper takes the keys explicitly.
		const keys = duplicateDeliveryKeys(messages);
		assert.deepEqual(messageViewLines(messages[3]!, "m37", new Set(), keys), []);
		assert.deepEqual(messageViewLines(messages[3]!, "m37", new Set()), [`TEACHER [m37] ${LESSON}`]);
	});

	it("the model-facing history is untouched", () => {
		const llm = JSON.stringify(toLlmMessages(realShape()));
		assert.equal(llm.split("The plan:").length - 1, 2, "both copies still go back to the model");
	});
});

describe("messages still streaming (prefix rule)", () => {
	// streamingIds is consume-scoped (never shrinks on message_end); streamingMessageId is the ONE message streaming right now.
	const live = (streaming: string | null, ...settledInConsume: string[]) => ({
		inFlight: true,
		streamingIds: new Set([...(streaming ? [streaming] : []), ...settledInConsume]),
		streamingMessageId: streaming,
		executions: new Map(),
	});
	const assistantText = (messages: LhMessage[], state: Parameters<typeof projectView>[1]) =>
		projectView(messages, state).filter((m) => m.role === "assistant").flatMap((m) => m.parts).filter((p) => p.type === "text").map((p) => p.text);
	const partial = (t: string) => realShape(t);

	it("detector: a streaming partial prefix is hidden, from the first character on", () => {
		for (const part of ["H", "Here is", "Here is what we will cover.\n\nThe pl", LESSON.slice(0, -1), LESSON]) {
			assert.deepEqual([...duplicateDeliveryKeys(partial(part), { inFlight: new Set(["m37"]) })], ["m37:0"], part);
		}
	});

	it("detector: the same partial is shown when the message is settled (strict equality)", () => {
		assert.equal(duplicateDeliveryKeys(partial("Here is what we will")).size, 0);
		assert.equal(duplicateDeliveryKeys(partial("Here is what we will"), { inFlight: new Set(["other"]) }).size, 0);
	});

	it("detector: a streaming recap that diverges is shown once it diverges", () => {
		const opts = { inFlight: new Set(["m37"]) };
		assert.equal(duplicateDeliveryKeys(partial("Here is what"), opts).size, 1, "still a prefix");
		assert.equal(duplicateDeliveryKeys(partial("Here is what I will recap"), opts).size, 0, "diverged");
		assert.equal(duplicateDeliveryKeys(partial(`${LESSON} And more.`), opts).size, 0, "a superset is never a duplicate");
	});

	it("detector: the prefix rule needs a delivered call in the same turn", () => {
		const opts = { inFlight: new Set(["m37"]) };
		const failed = [user("u1"), assistant("m35", [send(LESSON)], "toolUse"), ack("send-1", true), assistant("m37", [text("Here is what")])];
		assert.equal(duplicateDeliveryKeys(failed, opts).size, 0);
		const prevTurn = [user("u1"), assistant("m35", [send(LESSON)], "toolUse"), ack(), user("u2"), assistant("m37", [text("Here is what")])];
		assert.equal(duplicateDeliveryKeys(prevTurn, opts).size, 0);
	});

	it("lesson view: a streaming partial copy is not shown; a diverged recap is; settled unchanged", () => {
		assert.deepEqual(projectView(partial("Here is what we will"), live("m37")).filter((m) => m.role === "assistant").flatMap((m) => m.parts).filter((p) => p.type === "text").map((p) => p.text), [LESSON]);
		const diverged = projectView(partial("Here is what I will recap"), live("m37")).filter((m) => m.role === "assistant").flatMap((m) => m.parts).filter((p) => p.type === "text").map((p) => p.text);
		assert.deepEqual(diverged, [LESSON, "Here is what I will recap"]);
		assert.deepEqual(viewProse(partial("Here is what we will")), [LESSON, "Here is what we will"], "settled partial text stays visible");
	});

	it("lesson view: a settled prefix message sharing streamingIds with the streaming one stays visible", () => {
		const base = [user("u1"), assistant("m1", [send(LESSON)], "toolUse"), ack()];
		const messages = [...base, assistant("m2", [text("Here is what")]), assistant("m3", [text("Here is what we will")])];
		// m2 settled earlier in this consume (still in streamingIds); m3 is streaming now.
		assert.deepEqual(assistantText(messages, live("m3", "m1", "m2")), [LESSON, "Here is what"], "m3 hidden, m2 shown");
		// Between messages (no message streaming): the settled prefix text is shown.
		assert.deepEqual(assistantText(messages, live(null, "m1", "m2", "m3")), [LESSON, "Here is what", "Here is what we will"]);
		// A caller that does not report the streaming message gets strict equality.
		const legacy = { inFlight: true, streamingIds: new Set(["m1", "m2", "m3"]), executions: new Map() };
		assert.deepEqual(assistantText(messages, legacy), [LESSON, "Here is what", "Here is what we will"]);
	});

	it("empty and whitespace-only streaming text is never hidden", () => {
		const opts = { inFlight: new Set(["m37"]) };
		for (const blank of ["", "   ", "\n\t \n"]) {
			assert.equal(duplicateDeliveryKeys(partial(blank), opts).size, 0, JSON.stringify(blank));
		}
	});
});
