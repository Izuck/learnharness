"use client";

import { useEffect, useState } from "react";

import { cliNoticeOf, cliRateLimitOf, type LhMessage } from "@/src/core";

// setTimeout silently fires at once past this many milliseconds.
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * The CLI's plan-limit warning as a non-blocking note, in the register of the turn-error
 * banner but never in its place. It states the reset time relative to now, and removes
 * itself when that time passes, when a newer report supersedes it, or when the lesson
 * is no longer on the Claude Code CLI.
 */
export function PlanLimitNote({ messages, selectedModel }: { messages: readonly LhMessage[]; selectedModel: string | undefined }) {
	const [, tick] = useState(0);
	const info = cliRateLimitOf(messages, selectedModel);
	const resetsAt = info?.resetsAt;

	useEffect(() => {
		if (resetsAt === undefined) return;
		const ms = (resetsAt > 1e11 ? resetsAt : resetsAt * 1000) - Date.now();
		const timer = setTimeout(() => tick((n) => n + 1), Math.min(Math.max(ms, 0) + 50, MAX_TIMER_MS));
		return () => clearTimeout(timer);
	}, [resetsAt]);

	const text = cliNoticeOf(messages, selectedModel);
	if (!text) return null;
	return (
		<div role="status" data-testid="cli-notice" className="rounded-lg border border-border bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
			{text}
		</div>
	);
}
