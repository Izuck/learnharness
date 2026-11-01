import assert from "node:assert/strict";
import test from "node:test";

import { cliErrorMessage, rateLimitNotice } from "../src/core/cli-errors.ts";
import { parseCliLine } from "../src/agent/claude-code/cli-events.ts";
import { cliNoticeOf, type LhMessage } from "../src/core/native-messages.ts";

const NOW = Date.UTC(2026, 10, 1, 12, 0, 0);
const BUSY = "Claude is busy right now. Try again in a moment.";
const SIGNED_OUT = `Claude Code isn't signed in. Open a terminal and run "claude" once to sign in.`;
const CREDIT = "This request was billed to API credits and the balance is too low.";

test("CLI strings map to the shared sentences", () => {
	assert.equal(cliErrorMessage("API Error: Rate limit reached"), BUSY);
	assert.equal(cliErrorMessage("Credit balance is too low"), CREDIT);
	assert.equal(cliErrorMessage("authentication_failed"), SIGNED_OUT);
	assert.equal(cliErrorMessage("Not logged in · Please run /login"), SIGNED_OUT);
});

test("API provider SDK errors map to the same sentences", () => {
	assert.equal(cliErrorMessage('429 {"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}'), BUSY);
	assert.equal(cliErrorMessage('529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'), BUSY);
	assert.equal(cliErrorMessage('401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}'), SIGNED_OUT);
	assert.equal(cliErrorMessage('400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}'), CREDIT);
});

test("a plan or usage limit names the reset time and the API-key switch", () => {
	assert.equal(cliErrorMessage("You've hit your limit · resets 3pm (America/New_York)"), "Claude plan limit reached. It resets 3pm (America/New_York). Switch this lesson to your API key to keep going.");
	assert.equal(cliErrorMessage("Claude AI usage limit reached"), "Claude plan limit reached. It resets soon. Switch this lesson to your API key to keep going.");
	const epoch = Math.floor((NOW + 90 * 60_000) / 1000);
	assert.equal(cliErrorMessage(`Claude AI usage limit reached|${epoch}`, NOW), "Claude plan limit reached. It resets in 2 hours. Switch this lesson to your API key to keep going.");
});

test("an unknown string passes through unchanged, and mapping is idempotent", () => {
	for (const text of ["claude CLI kept calling tools the app does not offer (WebSearch)", "claude CLI ran a native tool (Bash) outside the app: 429 files", "boom"]) {
		assert.equal(cliErrorMessage(text), text);
	}
	for (const text of ["API Error: Rate limit reached", `Claude AI usage limit reached|${Math.floor((NOW + 3_600_000) / 1000)}`, "authentication_failed", "Credit balance is too low"]) {
		const once = cliErrorMessage(text, NOW);
		assert.equal(cliErrorMessage(once, NOW), once);
	}
});

const eventLine = (info: object) => ({ type: "rate_limit_event", rate_limit_info: info, uuid: "u", session_id: "s" });

test("rateLimitNotice speaks for a rejected or warning event and is silent for an allowed one", () => {
	const resetsAt = Math.floor((NOW + 25 * 60_000) / 1000);
	assert.equal(rateLimitNotice(eventLine({ status: "rejected", resetsAt, rateLimitType: "five_hour" }), NOW), "Claude plan limit reached. It resets in 25 minutes. Switch this lesson to your API key to keep going.");
	assert.equal(rateLimitNotice(eventLine({ status: "allowed_warning", resetsAt, utilization: 0.9 }), NOW), "Claude plan limit almost reached. It resets in 25 minutes. Switch this lesson to your API key to keep going.");
	assert.equal(rateLimitNotice(eventLine({ status: "rejected" }), NOW), "Claude plan limit reached. It resets soon. Switch this lesson to your API key to keep going.");
	assert.equal(rateLimitNotice(eventLine({ status: "allowed", resetsAt }), NOW), null);
});

test("rateLimitNotice is defensive about malformed input", () => {
	for (const bad of [null, undefined, 7, "x", {}, { type: "rate_limit_event" }, { type: "rate_limit_event", rate_limit_info: "no" }, { type: "other", rate_limit_info: { status: "rejected" } }]) {
		assert.equal(rateLimitNotice(bad, NOW), null);
	}
});

test("parseCliLine turns a warning rate_limit_event into a notice event and ignores an allowed one", () => {
	const warning = JSON.stringify(eventLine({ status: "allowed_warning", resetsAt: Math.floor(Date.now() / 1000) + 3 * 3600 }));
	const parsed = parseCliLine(warning);
	assert.equal(parsed?.type, "rateLimit");
	assert.match(parsed?.type === "rateLimit" ? parsed.notice : "", /^Claude plan limit almost reached\. It resets in 3 hours\. Switch this lesson to your API key/);
	assert.equal(parseCliLine(JSON.stringify(eventLine({ status: "allowed" }))), null);
	assert.equal(parseCliLine('{"type":"rate_limit_event"}'), null);
});

test("cliNoticeOf reports only the latest assistant response's notice", () => {
	const a = (extra: object) => ({ role: "assistant", content: [], id: "a", ...extra }) as unknown as LhMessage;
	assert.equal(cliNoticeOf([a({ cliNotice: "old" }), a({})]), null);
	assert.equal(cliNoticeOf([a({}), a({ cliNotice: "careful" })]), "careful");
	assert.equal(cliNoticeOf([]), null);
});
