import React from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { TurnUsage } from "../src/core/index.ts";
import { sessionCost } from "../src/server/pricing.ts";
import { StatsBar } from "../components/stats-bar.tsx";

const step = { inputTokens: 12_000, outputTokens: 800, cacheReadTokens: 3_000, cacheWriteTokens: 1_000, cacheWrite1hTokens: 0, reasoningTokens: undefined };
const cliTurn = (id: string, model = "claude-code:opus"): TurnUsage => ({ id, messageId: id, at: "2026-10-31T00:00:00Z", model, steps: [step, step] });

test("stats bar labels the estimate and keeps CLI as the fallback", () => {
	const turn = cliTurn("t1");
	const pricing = sessionCost({ turns: [turn] });
	const html = renderToStaticMarkup(<StatsBar turns={[turn]} pricing={pricing} />);
	assert.match(html, /data-testid="stats-cost">≈ \$\d+\.\d+ on plan<\/span>/);
	assert(!html.includes(">CLI<"));
	const bare = renderToStaticMarkup(<StatsBar turns={[turn]} pricing={{ cost: 0, unpriced: 1, turnCosts: { t1: null } }} />);
	assert.match(bare, /data-testid="stats-cost">CLI<\/span>/);
});
