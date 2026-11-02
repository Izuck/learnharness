/**
 * THE ONE BACKEND SWITCH (forest spec B): move every Anthropic model pin in
 * the settings record - the strong / cheap / vision slots and the background
 * role overrides - to the other backend in a single read-modify-write through
 * the settings store (the record's only writer). The pure mapping lives in
 * core/backend-parity.ts; this adds the two server concerns the mapping
 * cannot: persistence and the clamp-on-write rule (a pinned thinking level
 * lands clamped to the NEW model's nearest supported level, like every other
 * model swap).
 */

import { BACKEND_UNAVAILABLE_REASON, BACKGROUND_MODEL_ROLES, MODEL_SLOTS, type Backend, type ModelSlot, type RoleModelOverride, remapSettings } from "../core";
import type { UserSettings } from "../core/settings.ts";
import { endAllLiveSessions } from "../agent/claude-code/live-processes.ts";
import { clampLevelFor } from "./model-catalog.ts";
import { settingsStore } from "../store/settings.ts";
import { providerKeyPresent } from "./keys.ts";

/** The target backend cannot run right now (CLI off / no API key). */
export class BackendUnavailableError extends Error {
	constructor(readonly backend: Backend) {
		super(BACKEND_UNAVAILABLE_REASON[backend]);
		this.name = "BackendUnavailableError";
	}
}

function clampEntry<T extends ModelSlot | RoleModelOverride>(entry: T): T {
	if (!entry.model || entry.thinkingLevel === undefined) return entry;
	const thinkingLevel = clampLevelFor(entry.model.provider, entry.model.id, entry.thinkingLevel);
	return thinkingLevel === entry.thinkingLevel ? entry : { ...entry, thinkingLevel };
}

/** Switch every Anthropic pin to `to`. Returns what could not be mapped
 *  ("<where>: <id>"); those pins stay as they were. Throws
 *  BackendUnavailableError, writing nothing, when `to` cannot run: the same
 *  availability the catalog reports as providers[].keyPresent (the CLI is
 *  opted in and installed / an Anthropic key is saved), so the switch never
 *  writes pins that every new session and background job would refuse.
 *
 *  A switch to the API also ends every live CLI process, in every lesson, and stales the ones
 *  streaming right now (they end instead of idling when their turn finishes). Lessons that moved
 *  have no use for them, and an open question's answer now runs on the API. A lesson with its own
 *  CLI model pin stays on the CLI and replays once on its next turn, which costs less than tracking
 *  which lesson resolves to which backend. A process waiting on tool results loses its wait and
 *  its continuation replays, the trade saveChatSettings already makes; a turn still streaming
 *  finishes normally. */
export function switchBackend(to: Backend): { unmapped: string[] } {
	if (!providerKeyPresent(to)) throw new BackendUnavailableError(to);
	const before: UserSettings = settingsStore.readSettings() ?? { version: 1 };
	const { record, unmapped } = remapSettings(before, to);
	// Clamp only the entries the remap actually moved.
	if (record.models && before.models) {
		for (const slot of MODEL_SLOTS) {
			const entry = record.models[slot];
			if (entry && entry !== before.models[slot]) record.models[slot] = clampEntry(entry);
		}
	}
	const roles = record.agent?.models;
	if (roles && before.agent?.models) {
		for (const role of BACKGROUND_MODEL_ROLES) {
			const entry = roles[role];
			if (entry && entry !== before.agent.models[role]) roles[role] = clampEntry(entry);
		}
	}
	settingsStore.writeSettings(record);
	if (to === "anthropic") endAllLiveSessions();
	return { unmapped };
}
