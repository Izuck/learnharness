"use client";
/**
 * The "Run on: Claude plan / API key" row (forest spec B) at the top of the
 * Agent settings' Models group: ONE switch that moves every Claude pin (the
 * strong / cheap / vision slots and the background role overrides) between
 * the Claude Code CLI (billed to the Claude plan) and the Anthropic API
 * (billed per token). The mapping and the write live server-side
 * (POST /api/settings/backend); this row shows the current backend - or
 * "Mixed" when the pins disagree - and lists any pin that had no
 * counterpart. Same segmented look as the Quizzing row.
 */

import { useState } from "react";
import { notifySettingsSaved } from "@/components/settings-signal";
import { currentBackend, type Backend, type UserSettings } from "@/src/core";
import { cn } from "@/lib/utils";
import { SettingsRow } from "./controls.tsx";

const OPTIONS: readonly { backend: Backend; label: string }[] = [
	{ backend: "claude-code", label: "Claude plan" },
	{ backend: "anthropic", label: "API key" },
];

const LABEL: Record<Backend, string> = { "claude-code": "Claude plan", anthropic: "API key" };

/** The presentational row: current backend (or "mixed"/none), the two
 *  options, the unmapped note. Exported for the render tests. */
export function BackendSegments({
	current,
	unmapped,
	busy,
	error,
	onSwitch,
}: {
	current: Backend | "mixed" | null;
	unmapped: readonly string[];
	busy?: boolean;
	error?: string | null;
	onSwitch: (to: Backend) => void;
}) {
	return (
		<SettingsRow
			label="Run on"
			hint="Moves every Claude model between your Claude plan and your API key"
			testid="backend-row"
		>
			<div className="flex flex-col items-end gap-1">
				<div className="flex items-center gap-2">
					{current === "mixed" && (
						<span data-testid="backend-current" className="text-xs text-muted-foreground">Mixed</span>
					)}
					<div
						role="radiogroup"
						aria-label="Run on"
						className="flex rounded-lg border border-border/60 bg-muted/30 p-0.5"
					>
						{OPTIONS.map(({ backend, label }) => {
							const active = current === backend;
							return (
								<button
									key={backend}
									type="button"
									role="radio"
									aria-checked={active}
									disabled={busy}
									data-testid={`backend-${backend}`}
									onClick={() => {
										if (!active) onSwitch(backend);
									}}
									className={cn(
										"h-8 rounded-md px-3 text-sm font-medium transition-colors",
										active ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
									)}
								>
									{label}
								</button>
							);
						})}
					</div>
				</div>
				{unmapped.length > 0 && (
					<p data-testid="backend-unmapped" className="max-w-72 text-right text-xs text-muted-foreground/70">
						No equivalent model, left as it was: {unmapped.join(", ")}
					</p>
				)}
				{error && <p role="alert" className="text-xs text-red-400">{error}</p>}
			</div>
		</SettingsRow>
	);
}

/** The stateful row: POSTs the switch, hands the stored record to the
 *  dialog's mirror, and tells every other settings reader to re-read. */
export function BackendSwitchRow({
	record,
	onSwitched,
}: {
	/** The slices the current backend derives from. */
	record: Pick<UserSettings, "models" | "agent">;
	/** The stored record the route answered with (the dialog's mirror). */
	onSwitched?: (settings: UserSettings) => void;
}) {
	const [unmapped, setUnmapped] = useState<string[]>([]);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function switchTo(to: Backend) {
		setBusy(true);
		setError(null);
		try {
			const res = await fetch("/api/settings/backend", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ to }),
			});
			if (!res.ok) {
				const body = (await res.json().catch(() => ({}))) as { error?: string };
				setError(body.error ?? `Could not switch to ${LABEL[to]} (${res.status})`);
				return;
			}
			const body = (await res.json()) as { unmapped?: string[]; settings?: UserSettings | null };
			setUnmapped(body.unmapped ?? []);
			if (body.settings) onSwitched?.(body.settings);
			notifySettingsSaved("models");
			notifySettingsSaved("agent");
		} catch {
			setError("Could not reach the server - try again.");
		} finally {
			setBusy(false);
		}
	}

	return (
		<BackendSegments
			current={currentBackend({ version: 1, ...record })}
			unmapped={unmapped}
			busy={busy}
			error={error}
			onSwitch={(to) => void switchTo(to)}
		/>
	);
}
