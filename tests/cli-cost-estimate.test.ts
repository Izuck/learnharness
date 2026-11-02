import assert from "node:assert/strict";
import { test } from "node:test";
import type { TurnUsage } from "../src/core/index.ts";
import { callCost, estimatedCallCost, jobCost, sessionCost, turnCost } from "../src/server/pricing.ts";

const step = { inputTokens: 12_000, outputTokens: 800, cacheReadTokens: 3_000, cacheWriteTokens: 1_000, cacheWrite1hTokens: 0, reasoningTokens: undefined };
const cliTurn = (id: string, model = "claude-code:opus"): TurnUsage => ({ id, messageId: id, at: "2026-10-31T00:00:00Z", model, steps: [step, step] });

test("a CLI call is estimated at its API twin's catalog rate", () => {
	const api = callCost(step, "anthropic:claude-opus-5-5");
	assert(api !== null && api > 0, "the API twin is priced");
	assert.equal(estimatedCallCost(step, "claude-code:opus"), api);
	assert.equal(estimatedCallCost(step, "claude-code:haiku"), callCost(step, "anthropic:claude-haiku-5-5"));
});

test("unknown aliases and non-CLI models have no estimate", () => {
	assert.equal(estimatedCallCost(step, "claude-code:nonesuch"), null);
	assert.equal(estimatedCallCost(step, "anthropic:claude-opus-5-5"), null);
	assert.equal(estimatedCallCost({ inputTokens: 1 }, "claude-code:opus"), null);
});

test("the estimate never becomes real spend", () => {
	assert.equal(callCost(step, "claude-code:opus"), null);
	const turn = cliTurn("t1");
	assert.equal(turnCost(turn), null);
	const pricing = sessionCost({ turns: [turn] });
	assert.equal(pricing.cost, 0);
	assert.equal(pricing.unpriced, 1);
	assert.equal(pricing.turnCosts.t1, null);
	assert.equal(jobCost({ usage: { model: "claude-code:opus", steps: 1, ...step } as never }), null);
});

test("sessionCost ships a separate estimate for fully estimable CLI turns", () => {
	const pricing = sessionCost({ turns: [cliTurn("t1"), cliTurn("t2", "claude-code:sonnet")] });
	const one = estimatedCallCost(step, "claude-code:opus")! * 2;
	const two = estimatedCallCost(step, "claude-code:sonnet")! * 2;
	assert.equal(pricing.estimatedTurnCosts?.t1, one);
	assert.equal(pricing.estimatedTurnCosts?.t2, two);
	assert.equal(pricing.estimatedCost, one + two);
	assert.equal(pricing.estimatedUnpriced, 0);
});

test("a CLI turn with no steps (aborted, failed, empty) estimates at $0 instead of spoiling the session's estimate", () => {
	const empty: TurnUsage = { ...cliTurn("t0"), steps: [] };
	const pricing = sessionCost({ turns: [cliTurn("t1"), empty] });
	assert.equal(pricing.estimatedTurnCosts?.t0, 0);
	assert.equal(pricing.estimatedCost, estimatedCallCost(step, "claude-code:opus")! * 2);
	assert.equal(pricing.estimatedUnpriced, 0);
});
