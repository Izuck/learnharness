/**
 * One error vocabulary for both Anthropic backends (the Claude Code CLI and the
 * pi-ai `anthropic` API provider). Each backend reports the same situations in
 * its own words; the learner sees one sentence per situation, whichever backend
 * the lesson runs on. Anything unrecognised passes through unchanged.
 */

export const PLAN_LIMIT_PREFIX = "Claude plan limit reached.";
export const PLAN_LIMIT_WARNING_PREFIX = "Claude plan limit almost reached.";
export const BUSY_MESSAGE = "Claude is busy right now. Try again in a moment.";
export const NOT_SIGNED_IN_MESSAGE = `Claude Code isn't signed in. Open a terminal and run "claude" once to sign in.`;
export const CREDIT_MESSAGE = "This request was billed to API credits and the balance is too low.";

const OUR_SENTENCES = [PLAN_LIMIT_PREFIX, PLAN_LIMIT_WARNING_PREFIX, BUSY_MESSAGE, NOT_SIGNED_IN_MESSAGE, CREDIT_MESSAGE];

const CREDIT = /credit balance (?:is )?too low/i;
// The CLI words a plan or usage limit as "You've hit your limit · resets 3pm" or
// "Claude AI usage limit reached|<epoch seconds>".
const PLAN_LIMIT = /usage limit reached|you['’]ve hit your (?:\w+ )?limit/i;
const NOT_SIGNED_IN = /authentication_failed|authentication_error|not logged in|please run \/login|invalid x-api-key|^\s*(?:API Error:\s*)?401\b/i;
const BUSY = /rate[_ ]?limit|overloaded|too many requests|^\s*(?:API Error:\s*)?(?:429|529)\b/i;

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

export function cliErrorMessage(raw: string, now = Date.now()): string {
	if (OUR_SENTENCES.some((sentence) => raw.startsWith(sentence))) return raw;
	if (CREDIT.test(raw)) return CREDIT_MESSAGE;
	if (PLAN_LIMIT.test(raw)) return `${PLAN_LIMIT_PREFIX} It resets ${planLimitWhen(raw, now)}. Switch this lesson to your API key to keep going.`;
	if (NOT_SIGNED_IN.test(raw)) return NOT_SIGNED_IN_MESSAGE;
	if (BUSY.test(raw)) return BUSY_MESSAGE;
	return raw;
}

/**
 * A note for a `rate_limit_event` line, or null when nothing needs saying.
 *
 * Shape (read from the installed CLI 2.1.x binary's SDK message schema, not from
 * a live run): `{ type: "rate_limit_event", rate_limit_info: { status:
 * "allowed" | "allowed_warning" | "rejected", resetsAt?: <epoch seconds>,
 * rateLimitType?, utilization?, ... }, uuid, session_id }`. Parsed defensively:
 * anything that is not an object carrying a warning or rejected status gives null.
 */
export function rateLimitNotice(event: unknown, now = Date.now()): string | null {
	if (typeof event !== "object" || event === null) return null;
	const line = event as { type?: unknown; rate_limit_info?: unknown };
	if (line.type !== "rate_limit_event") return null;
	const info = (typeof line.rate_limit_info === "object" && line.rate_limit_info !== null ? line.rate_limit_info : {}) as { status?: unknown; resetsAt?: unknown };
	const tail = `It resets ${resetsIn(info.resetsAt, now)}. Switch this lesson to your API key to keep going.`;
	if (info.status === "rejected") return `${PLAN_LIMIT_PREFIX} ${tail}`;
	if (info.status === "allowed_warning") return `${PLAN_LIMIT_WARNING_PREFIX} ${tail}`;
	return null;
}
