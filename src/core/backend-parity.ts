/**
 * BACKEND PARITY (forest spec B): the app talks to Claude through two
 * backends - the Claude Code CLI (provider `claude-code`, aliases
 * opus / sonnet / haiku, billed to the Claude plan) and the Anthropic API
 * (provider `anthropic`, full ids, billed per token). They run the same
 * model families, so the owner flips between them with ONE switch: this
 * module is the pure mapping behind it (ids, one spec, the whole settings
 * record). Browser-safe, no I/O; the writer is src/server/backend-switch.ts.
 */

import { CLAUDE_CODE_PROVIDER } from "./contracts/claude-code.ts";
import {
	BACKGROUND_MODEL_ROLES,
	MODEL_SLOTS,
	type ModelSlot,
	type RoleModelOverride,
	type UserSettings,
} from "./settings.ts";

export type Backend = "claude-code" | "anthropic";

/** The API provider's id (pi-ai's `anthropic`). */
const ANTHROPIC_PROVIDER = "anthropic";

/** The CLI alias -> the API id it stands for (the current generation). */
export const CLI_TO_API: Readonly<Record<string, string>> = {
	opus: "claude-opus-5-5",
	sonnet: "claude-sonnet-5-5",
	haiku: "claude-haiku-5-5",
};

const PROVIDER_OF: Record<Backend, string> = {
	"claude-code": CLAUDE_CODE_PROVIDER,
	anthropic: ANTHROPIC_PROVIDER,
};

/** The API id for a CLI alias; null when the alias is unknown. */
export function toApiModelId(cliId: string): string | null {
	return Object.hasOwn(CLI_TO_API, cliId) ? CLI_TO_API[cliId]! : null;
}

/** The CLI alias for an API id, BY FAMILY (claude-opus-4-8 -> opus: the CLI
 *  has no per-version ids); null when the id names no CLI family. */
export function toCliModelId(apiId: string): string | null {
	const family = /^claude-(?:\d+-)*(opus|sonnet|haiku)(?:-|$)/.exec(apiId)?.[1];
	return family ?? null;
}

/** Which Anthropic backend a spec's provider is; null for any other provider. */
export function backendOf(spec: { provider: string }): Backend | null {
	if (spec.provider === CLAUDE_CODE_PROVIDER) return "claude-code";
	if (spec.provider === ANTHROPIC_PROVIDER) return "anthropic";
	return null;
}

/** Move one spec to the other backend, every other field riding along
 *  (thinkingLevel included - the writer clamps it to the new model).
 *  `unmapped` = an Anthropic spec whose id has no counterpart (kept as is). */
export function remapSpec<T extends { provider: string; id: string }>(
	spec: T,
	to: Backend,
): { spec: T; changed: boolean; unmapped: boolean } {
	const from = backendOf(spec);
	if (from === null || from === to) return { spec, changed: false, unmapped: false };
	const id = to === "anthropic" ? toApiModelId(spec.id) : toCliModelId(spec.id);
	if (id === null) return { spec, changed: false, unmapped: true };
	return { spec: { ...spec, provider: PROVIDER_OF[to], id }, changed: true, unmapped: false };
}

/** One slot / role override: remap its model pair, report what could not map. */
function remapEntry<T extends ModelSlot | RoleModelOverride>(
	entry: T,
	where: string,
	to: Backend,
	unmapped: string[],
): T {
	if (!entry.model) return entry;
	const out = remapSpec(entry.model, to);
	if (out.unmapped) unmapped.push(`${where}: ${entry.model.id}`);
	return out.changed ? { ...entry, model: out.spec } : entry;
}

/** Remap the whole record: the strong / cheap / vision slots and every
 *  background-role override. Anything else rides untouched; the input is
 *  never mutated. `unmapped` lists "<where>: <id>" for pins that stayed. */
export function remapSettings(record: UserSettings, to: Backend): { record: UserSettings; unmapped: string[] } {
	const unmapped: string[] = [];
	const out: UserSettings = { ...record };
	if (record.models) {
		const models = { ...record.models };
		for (const slot of MODEL_SLOTS) {
			const entry = models[slot];
			if (entry) models[slot] = remapEntry(entry, slot, to, unmapped);
		}
		out.models = models;
	}
	const roles = record.agent?.models;
	if (roles) {
		const next = { ...roles };
		for (const role of BACKGROUND_MODEL_ROLES) {
			const entry = next[role];
			if (entry) next[role] = remapEntry(entry, role, to, unmapped);
		}
		out.agent = { ...record.agent, models: next };
	}
	return { record: out, unmapped };
}

/** The backend the record currently runs: the one every Anthropic pin
 *  (slots + role overrides) agrees on, "mixed" when they disagree, null when
 *  nothing is pinned to either (other providers do not vote). */
export function currentBackend(record: UserSettings): Backend | "mixed" | null {
	const seen = new Set<Backend>();
	const vote = (entry: { model?: { provider: string } } | undefined) => {
		const backend = entry?.model ? backendOf(entry.model) : null;
		if (backend) seen.add(backend);
	};
	for (const slot of MODEL_SLOTS) vote(record.models?.[slot]);
	for (const role of BACKGROUND_MODEL_ROLES) vote(record.agent?.models?.[role]);
	if (seen.size > 1) return "mixed";
	return seen.values().next().value ?? null;
}
