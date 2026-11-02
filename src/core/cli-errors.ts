/**
 * One error vocabulary for both Anthropic backends (the Claude Code CLI and the
 * pi-ai `anthropic` API provider). Each backend reports the same situations in
 * its own words; the learner sees one sentence per situation, whichever backend
 * the lesson runs on. Anything unrecognised passes through unchanged.
 *
 * Matching is anchored to error shapes (an HTTP status prefix, an `*_error` type
 * field, the CLI's structured error code) rather than loose words, so a message
 * that merely mentions "rate limit" or "429" is never rewritten.
 */

export type ErrorBackend = "claude-code" | "anthropic";

export const PLAN_LIMIT_PREFIX = "Claude plan limit reached.";
export const PLAN_LIMIT_WARNING_PREFIX = "Claude plan limit almost reached.";
export const BUSY_MESSAGE = "Claude is busy right now. Try again in a moment.";
export const NOT_SIGNED_IN_MESSAGE = `Claude Code isn't signed in. Open a terminal and run "claude" once to sign in.`;
export const KEY_REJECTED_MESSAGE = "Your Anthropic API key was rejected. Check it in Settings → Keys.";
export const CREDIT_MESSAGE = "This request was billed to API credits and the balance is too low.";
export const SPEND_LIMIT_MESSAGE = "Your Anthropic spend limit has been reached. Raise it in the Anthropic console, or wait until it resets.";

const OUR_SENTENCES = [PLAN_LIMIT_PREFIX, PLAN_LIMIT_WARNING_PREFIX, BUSY_MESSAGE, NOT_SIGNED_IN_MESSAGE, KEY_REJECTED_MESSAGE, CREDIT_MESSAGE, SPEND_LIMIT_MESSAGE];

const CREDIT = /credit balance (?:is )?too low/i;
// "You have reached your specified API usage limits. You will regain access on ..." (API) and
// "You've hit your monthly spend limit" (CLI): an account cap, not a busy server.
const SPEND_LIMIT = /specified api usage limits?|regain access on|\bspend(?:ing)? limit\b/i;
// The CLI words a plan or usage limit as "You've hit your limit · resets 3pm" or
// "Claude AI usage limit reached|<epoch seconds>".
const PLAN_LIMIT = /usage limit reached|you['’]ve hit your (?:\w+ )?limit/i;
const CLI_NOT_SIGNED_IN = /authentication_failed|not logged in|please run \/login/i;
const CLI_BUSY_TEXT = /\brate limit reached\b|\boverloaded\b/i;
const KEY_REJECTED_TEXT = /invalid x-api-key/i;

/** The wire shape of an Anthropic API failure: a leading HTTP status (optionally after the
 *  CLI's "API Error: ") and the error body's `*_error` type field. */
function errorShape(raw: string): { status?: number; type?: string } {
	const status = /^\s*(?:API Error:\s*)?(\d{3})\b/.exec(raw)?.[1];
	const type = /"type"\s*:\s*"([a-z]+(?:_[a-z]+)*_error)"/.exec(raw)?.[1];
	return { ...(status ? { status: Number(status) } : {}), ...(type ? { type } : {}) };
}

/** "in 25 minutes" / "in 2 hours" / "in 3 days"; "soon" when unknown or already past.
 *  `epoch` is seconds since the epoch (milliseconds tolerated). */
export function resetsIn(epoch: unknown, now = Date.now()): string {
	if (typeof epoch !== "number" || !Number.isFinite(epoch) || epoch <= 0) return "soon";
	const ms = epoch > 1e11 ? epoch : epoch * 1000;
	const seconds = Math.round((ms - now) / 1000);
	if (seconds <= 0) return "soon";
	const minutes = Math.max(1, Math.round(seconds / 60));
	if (minutes < 60) return `in ${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
	const hours = Math.round(minutes / 60);
	if (hours < 48) return `in ${hours} ${hours === 1 ? "hour" : "hours"}`;
	return `in ${Math.round(hours / 24)} days`;
}

function planLimitWhen(raw: string, now: number): string {
	const epoch = /\|\s*(\d{9,13})\b/.exec(raw);
	if (epoch) return resetsIn(Number(epoch[1]), now);
	const said = /\bresets?\s+((?:at |in |on )?[^.·|\n]*?)\s*(?:[.·|\n]|$)/i.exec(raw);
	return said?.[1]?.trim() ? said[1].trim() : "soon";
}

function planLimitMessage(raw: string, now: number): string {
	return `${PLAN_LIMIT_PREFIX} It resets ${planLimitWhen(raw, now)}. Switch this lesson to your API key to keep going.`;
}

export interface ErrorOptions {
	/** The CLI's structured error code on an assistant error line (`authentication_failed`, `billing_error`, ...). */
	code?: string;
	/** The CLI's plan-limit report for the response that failed (its latest `rate_limit_event`). A
	 *  still-active "rejected" one is the structured plan-limit signal: the CLI words that failure
	 *  like a plain 429, so the code and text cannot tell them apart. Text only matters without it. */
	rateLimit?: RateLimitInfo | null;
	now?: number;
}

export function cliErrorMessage(raw: string, backend: ErrorBackend, options: ErrorOptions = {}): string {
	const now = options.now ?? Date.now();
	if (OUR_SENTENCES.some((sentence) => raw.startsWith(sentence))) return raw;
	const { status, type } = errorShape(raw);
	if (backend === "claude-code") {
		// The CLI's code is the most reliable signal for sign-in; text only refines the rest.
		if (options.code === "authentication_failed") return NOT_SIGNED_IN_MESSAGE;
		if (CREDIT.test(raw)) return CREDIT_MESSAGE;
		if (SPEND_LIMIT.test(raw)) return SPEND_LIMIT_MESSAGE;
		if (options.rateLimit?.status === "rejected" && rateLimitActive(options.rateLimit, now)) return planLimitNotice(options.rateLimit, now) ?? raw;
		if (PLAN_LIMIT.test(raw)) return planLimitMessage(raw, now);
		if (options.code === "billing_error") return CREDIT_MESSAGE;
		if (CLI_NOT_SIGNED_IN.test(raw) || status === 401 || type === "authentication_error" || KEY_REJECTED_TEXT.test(raw)) return NOT_SIGNED_IN_MESSAGE;
		if (CLI_BUSY_TEXT.test(raw) || status === 429 || status === 529 || type === "rate_limit_error" || type === "overloaded_error") return BUSY_MESSAGE;
		return raw;
	}
	if (CREDIT.test(raw)) return CREDIT_MESSAGE;
	if (SPEND_LIMIT.test(raw)) return SPEND_LIMIT_MESSAGE;
	if (status === 401 || type === "authentication_error" || KEY_REJECTED_TEXT.test(raw)) return KEY_REJECTED_MESSAGE;
	if (status === 429 || status === 529 || type === "rate_limit_error" || type === "overloaded_error") return BUSY_MESSAGE;
	return raw;
}

/** What the CLI reports about the plan's limit window. `resetsAt` is epoch seconds. */
export interface RateLimitInfo {
	status: "allowed" | "allowed_warning" | "rejected";
	resetsAt?: number;
}

/**
 * The status and reset time of a `rate_limit_event` line, or null when the line is not one
 * or carries no recognisable status.
 *
 * Shape (read from the installed CLI 2.1.x binary's SDK message schema, not from a live
 * run): `{ type: "rate_limit_event", rate_limit_info: { status:
 * "allowed" | "allowed_warning" | "rejected", resetsAt?: <epoch seconds>,
 * rateLimitType?, utilization?, ... }, uuid, session_id }`. Parsed defensively.
 */
export function parseRateLimitInfo(event: unknown): RateLimitInfo | null {
	if (typeof event !== "object" || event === null) return null;
	const line = event as { type?: unknown; rate_limit_info?: unknown };
	if (line.type !== "rate_limit_event" || typeof line.rate_limit_info !== "object" || line.rate_limit_info === null) return null;
	const info = line.rate_limit_info as { status?: unknown; resetsAt?: unknown };
	if (info.status !== "allowed" && info.status !== "allowed_warning" && info.status !== "rejected") return null;
	const resetsAt = typeof info.resetsAt === "number" && Number.isFinite(info.resetsAt) && info.resetsAt > 0 ? info.resetsAt : undefined;
	return resetsAt === undefined ? { status: info.status } : { status: info.status, resetsAt };
}

/** True while a warning or rejection still applies: not "allowed", and its reset time (if known) is ahead. */
export function rateLimitActive(info: RateLimitInfo | null | undefined, now = Date.now()): info is RateLimitInfo {
	if (!info || info.status === "allowed") return false;
	if (info.resetsAt === undefined) return true;
	const ms = info.resetsAt > 1e11 ? info.resetsAt : info.resetsAt * 1000;
	return ms > now;
}

/** The learner-facing sentence for a still-active warning or rejection, with the reset time relative to `now`. */
export function planLimitNotice(info: RateLimitInfo | null | undefined, now = Date.now()): string | null {
	if (!rateLimitActive(info, now)) return null;
	const prefix = info.status === "rejected" ? PLAN_LIMIT_PREFIX : PLAN_LIMIT_WARNING_PREFIX;
	return `${prefix} It resets ${resetsIn(info.resetsAt, now)}. Switch this lesson to your API key to keep going.`;
}

/** A note for a `rate_limit_event` line, or null when nothing needs saying. */
export function rateLimitNotice(event: unknown, now = Date.now()): string | null {
	return planLimitNotice(parseRateLimitInfo(event), now);
}
