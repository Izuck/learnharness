import assert from "node:assert/strict";
import test from "node:test";

import { cliErrorMessage, rateLimitNotice } from "../src/core/cli-errors.ts";
import { parseCliLine } from "../src/agent/claude-code/cli-events.ts";
import { cliNoticeOf, cliRateLimitOf, type LhMessage } from "../src/core/native-messages.ts";

const NOW = Date.UTC(2026, 10, 1, 12, 0, 0);
const BUSY = "Claude is busy right now. Try again in a moment.";
const SIGNED_OUT = `Claude Code isn't signed in. Open a terminal and run "claude" once to sign in.`;
const KEY_REJECTED = "Your Anthropic API key was rejected. Check it in Settings → Keys.";
const CREDIT = "This request was billed to API credits and the balance is too low.";
const SPEND = "Your Anthropic spend limit has been reached. Raise it in the Anthropic console, or wait until it resets.";

test("CLI strings map to the shared sentences", () => {
	assert.equal(cliErrorMessage("API Error: Rate limit reached", "claude-code"), BUSY);
	assert.equal(cliErrorMessage("Credit balance is too low", "claude-code"), CREDIT);
	assert.equal(cliErrorMessage("authentication_failed", "claude-code"), SIGNED_OUT);
	assert.equal(cliErrorMessage("Not logged in · Please run /login", "claude-code"), SIGNED_OUT);
});

test("a CLI auth failure says sign in; an API auth failure says the key was rejected", () => {
	const sdk401 = '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}';
	assert.equal(cliErrorMessage(sdk401, "anthropic"), KEY_REJECTED);
	assert.equal(cliErrorMessage("invalid x-api-key", "anthropic"), KEY_REJECTED);
	assert.equal(cliErrorMessage(`API Error: ${sdk401}`, "claude-code"), SIGNED_OUT);
	assert.equal(cliErrorMessage("Not logged in · Please run /login", "anthropic"), "Not logged in · Please run /login", "CLI wording is not an API shape");
});

test("the CLI's structured error code is matched before its text", () => {
	assert.equal(cliErrorMessage("Something the CLI worded oddly", "claude-code", { code: "authentication_failed" }), SIGNED_OUT);
	assert.equal(cliErrorMessage("Something the CLI worded oddly", "claude-code", { code: "billing_error" }), CREDIT);
	// Text that names a more specific situation still wins over a generic code.
	assert.match(cliErrorMessage("You've hit your limit · resets 3pm", "claude-code", { code: "rate_limit" }), /^Claude plan limit reached\. It resets 3pm\./);
	assert.equal(cliErrorMessage("Something the CLI worded oddly", "claude-code", { code: "unknown" }), "Something the CLI worded oddly");
});

test("API provider SDK errors map by status and error type, not by loose words", () => {
	assert.equal(cliErrorMessage('429 {"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}', "anthropic"), BUSY);
	assert.equal(cliErrorMessage('529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', "anthropic"), BUSY);
	assert.equal(cliErrorMessage('400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}', "anthropic"), CREDIT);
	// Words alone are not an error shape: a message that merely mentions them is left alone.
	assert.equal(cliErrorMessage("Summarise the rate limit docs", "anthropic"), "Summarise the rate limit docs");
	assert.equal(cliErrorMessage("the file is overloaded with 429 rows", "anthropic"), "the file is overloaded with 429 rows");
	assert.equal(cliErrorMessage("Request failed: 401 Unauthorized from the proxy at step 3", "anthropic"), "Request failed: 401 Unauthorized from the proxy at step 3");
});

test("a spend cap or API usage limit has its own sentence, not 'busy'", () => {
	const cap = '429 {"type":"error","error":{"type":"rate_limit_error","message":"You have reached your specified API usage limits. You will regain access on 2026-11-01 at 00:00 UTC."}}';
	assert.equal(cliErrorMessage(cap, "anthropic"), SPEND);
	assert.equal(cliErrorMessage("You've hit your monthly spend limit", "claude-code"), SPEND);
	assert.equal(cliErrorMessage(`API Error: ${cap}`, "claude-code"), SPEND);
});

test("a plan or usage limit names the reset time and the API-key switch", () => {
	assert.equal(cliErrorMessage("You've hit your limit · resets 3pm (America/New_York)", "claude-code"), "Claude plan limit reached. It resets 3pm (America/New_York). Switch this lesson to your API key to keep going.");
	assert.equal(cliErrorMessage("Claude AI usage limit reached", "claude-code"), "Claude plan limit reached. It resets soon. Switch this lesson to your API key to keep going.");
	const epoch = Math.floor((NOW + 90 * 60_000) / 1000);
	assert.equal(cliErrorMessage(`Claude AI usage limit reached|${epoch}`, "claude-code", { now: NOW }), "Claude plan limit reached. It resets in 2 hours. Switch this lesson to your API key to keep going.");
});

test("an unknown string passes through unchanged, and mapping is idempotent", () => {
	for (const text of ["claude CLI kept calling tools the app does not offer (WebSearch)", "claude CLI ran a native tool (Bash) outside the app: 429 files", "boom"]) {
		assert.equal(cliErrorMessage(text, "claude-code"), text);
		assert.equal(cliErrorMessage(text, "anthropic"), text);
	}
	for (const backend of ["claude-code", "anthropic"] as const) {
		for (const text of ["API Error: Rate limit reached", `Claude AI usage limit reached|${Math.floor((NOW + 3_600_000) / 1000)}`, "authentication_failed", "401 authentication_error", "Credit balance is too low", "You've hit your monthly spend limit"]) {
			const once = cliErrorMessage(text, backend, { now: NOW });
			assert.equal(cliErrorMessage(once, backend, { now: NOW }), once);
		}
	}
});

const eventLine = (info: object) => ({ type: "rate_limit_event", rate_limit_info: info, uuid: "u", session_id: "s" });

test("rateLimitNotice speaks for a rejected or warning event and is silent for an allowed one", () => {
	const resetsAt = Math.floor((NOW + 25 * 60_000) / 1000);
	assert.equal(rateLimitNotice(eventLine({ status: "rejected", resetsAt, rateLimitType: "five_hour" }), NOW), "Claude plan limit reached. It resets in 25 minutes. Switch this lesson to your API key to keep going.");
	assert.equal(rateLimitNotice(eventLine({ status: "allowed_warning", resetsAt, utilization: 0.9 }), NOW), "Claude plan limit almost reached. It resets in 25 minutes. Switch this lesson to your API key to keep going.");
	assert.equal(rateLimitNotice(eventLine({ status: "rejected" }), NOW), "Claude plan limit reached. It resets soon. Switch this lesson to your API key to keep going.");
	assert.equal(rateLimitNotice(eventLine({ status: "allowed", resetsAt }), NOW), null);
	assert.equal(rateLimitNotice(eventLine({ status: "rejected", resetsAt: Math.floor(NOW / 1000) - 60 }), NOW), null, "a reset time already past says nothing");
});

test("rateLimitNotice is defensive about malformed input", () => {
	for (const bad of [null, undefined, 7, "x", {}, { type: "rate_limit_event" }, { type: "rate_limit_event", rate_limit_info: "no" }, { type: "other", rate_limit_info: { status: "rejected" } }]) {
		assert.equal(rateLimitNotice(bad, NOW), null);
	}
});

test("parseCliLine keeps the status and reset time of every rate_limit_event that has one", () => {
	const resetsAt = Math.floor(Date.now() / 1000) + 3 * 3600;
	assert.deepEqual(parseCliLine(JSON.stringify(eventLine({ status: "allowed_warning", resetsAt }))), { type: "rateLimit", info: { status: "allowed_warning", resetsAt } });
	assert.deepEqual(parseCliLine(JSON.stringify(eventLine({ status: "rejected" }))), { type: "rateLimit", info: { status: "rejected" } });
	assert.deepEqual(parseCliLine(JSON.stringify(eventLine({ status: "allowed" }))), { type: "rateLimit", info: { status: "allowed" } }, "allowed supersedes an earlier warning");
	assert.equal(parseCliLine('{"type":"rate_limit_event"}'), null);
	assert.equal(parseCliLine(JSON.stringify(eventLine({ status: "mystery" }))), null);
});

const CLI_MODEL = "claude-code:opus";
const assistant = (extra: object = {}, provider = "claude-code") => ({ role: "assistant", content: [], id: "a", provider, model: "opus", ...extra }) as unknown as LhMessage;
const user = () => ({ role: "user", content: "hi", id: "u", timestamp: 0 }) as unknown as LhMessage;
const compaction = () => ({ id: "c", role: "custom", customType: "compaction", content: "summary", display: false, details: {}, timestamp: 1 }) as unknown as LhMessage;
const future = (hours = 2) => Math.floor((Date.now() + hours * 3_600_000) / 1000);

test("cliNoticeOf renders the latest warning until it expires or is superseded", () => {
	const warned = assistant({ cliRateLimit: { status: "allowed_warning", resetsAt: future() } });
	assert.match(cliNoticeOf([warned], CLI_MODEL) ?? "", /^Claude plan limit almost reached\. It resets in 2 hours\./);
	assert.equal(cliNoticeOf([], CLI_MODEL), null);
	// The next response carried no event: the warning still stands.
	assert.match(cliNoticeOf([warned, user(), assistant()], CLI_MODEL) ?? "", /almost reached/);
	// A later allowed event supersedes it; a later rejected one replaces it.
	assert.equal(cliNoticeOf([warned, assistant({ cliRateLimit: { status: "allowed" } })], CLI_MODEL), null);
	assert.match(cliNoticeOf([warned, assistant({ cliRateLimit: { status: "rejected", resetsAt: future(1) } })], CLI_MODEL) ?? "", /^Claude plan limit reached\. It resets in 1 hour\./);
	// Expired.
	assert.equal(cliNoticeOf([assistant({ cliRateLimit: { status: "rejected", resetsAt: Math.floor(Date.now() / 1000) - 5 } })], CLI_MODEL), null);
});

test("cliNoticeOf is relative to now at display time, not frozen at capture", () => {
	const at = Math.floor(Date.UTC(2026, 10, 1, 12, 0, 0) / 1000);
	const warned = assistant({ cliRateLimit: { status: "allowed_warning", resetsAt: at + 2 * 3600 } });
	assert.match(cliNoticeOf([warned], CLI_MODEL, at * 1000) ?? "", /resets in 2 hours/);
	assert.match(cliNoticeOf([warned], CLI_MODEL, (at + 3600) * 1000) ?? "", /resets in 1 hour/);
	assert.equal(cliNoticeOf([warned], CLI_MODEL, (at + 2 * 3600 + 1) * 1000), null);
	assert.deepEqual(cliRateLimitOf([warned], CLI_MODEL, at * 1000), { status: "allowed_warning", resetsAt: at + 2 * 3600 });
});

test("cliNoticeOf follows cliContextWindowOf: a trailing user message keeps it, a compaction marker clears it", () => {
	const warned = assistant({ cliRateLimit: { status: "allowed_warning", resetsAt: future() } });
	assert.match(cliNoticeOf([warned, user()], CLI_MODEL) ?? "", /almost reached/);
	assert.equal(cliNoticeOf([warned, compaction()], CLI_MODEL), null);
	assert.match(cliNoticeOf([compaction(), warned, user()], CLI_MODEL) ?? "", /almost reached/);
});

test("cliNoticeOf is hidden when the lesson's current backend is not the CLI", () => {
	const warned = assistant({ cliRateLimit: { status: "rejected", resetsAt: future() } });
	assert.equal(cliNoticeOf([warned], "anthropic:claude-opus-4-5"), null);
	assert.equal(cliNoticeOf([warned], undefined), null);
	assert.ok(cliNoticeOf([warned], "claude-code:sonnet"), "any CLI alias is the same plan");
	assert.equal(cliNoticeOf([assistant({ cliRateLimit: { status: "rejected", resetsAt: future() } }, "anthropic")], CLI_MODEL), null, "only a CLI response's report counts");
});
