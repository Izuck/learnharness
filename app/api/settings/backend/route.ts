import type { Backend } from "@/src/core";
import { BackendUnavailableError, readSettingsRecord, switchBackend } from "@/src/server";

export const dynamic = "force-dynamic";

/**
 * POST /api/settings/backend - the ONE "Run on: Claude plan / API key"
 * switch (forest spec B). Body `{ to: "claude-code" | "anthropic" }`: every
 * Anthropic model pin in the settings record (strong / cheap / vision slots
 * and the background role overrides) moves to that backend through the
 * settings store, thinking levels clamped to the new models. Returns
 * `{ unmapped, settings }`: the pins that had no counterpart and stayed, and
 * the stored record (server truth for the settings dialog's mirror).
 * 409 {error} when the target backend is unavailable (CLI not enabled or
 * installed / no Anthropic key saved); nothing is written then.
 * Per-session models are NOT touched - an open lesson has its own switch
 * (the per-chat settings route).
 */
export async function POST(request: Request) {
	const body = (await request.json().catch(() => null)) as { to?: unknown } | null;
	const to = body?.to;
	if (to !== "claude-code" && to !== "anthropic") {
		return Response.json({ error: 'to must be "claude-code" or "anthropic"' }, { status: 400 });
	}
	try {
		const { unmapped } = switchBackend(to as Backend);
		return Response.json({ unmapped, settings: readSettingsRecord() });
	} catch (error) {
		if (error instanceof BackendUnavailableError) return Response.json({ error: error.message }, { status: 409 });
		throw error;
	}
}
