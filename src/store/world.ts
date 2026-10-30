/**
 * WorldStore — the Cartographer's fs adapter for data/world (config.WORLD_FILES).
 *   topics.json       WorldFile — the generated world; read-whole, written
 *                     atomically (temp file + rename)
 *   placements.jsonl  Placement — append-only; the latest line per node wins
 *                     (resolution lives in core/world.ts mergePlacements)
 *
 * This adapter is the ONLY writer of data/world/* (the generation and layout
 * scripts write through it; WORLD.md and build/ are the generator's own
 * scratch). Reads are strict: an invalid topics.json reads as null and
 * corrupt placement lines are skipped, never guessed at. Same idioms as
 * src/store/graph.ts: sync fs, mkdirSync on write.
 *
 * Implements core/ports.ts WorldStore.
 */

import fs from "node:fs";
import path from "node:path";
import { WORLD_FILES } from "../../config.ts";
import type { Placement, WorldFile } from "../core/contracts/world.ts";
import type { WorldStore } from "../core/ports.ts";
import { isWorldFile } from "../core/world.ts";

function isPlacement(v: unknown): v is Placement {
	if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
	const p = v as Record<string, unknown>;
	return (
		typeof p.nodeId === "string" &&
		(p.topicId === null || typeof p.topicId === "string") &&
		typeof p.placedAt === "string"
	);
}

export function readWorld(): WorldFile | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(WORLD_FILES.topics, "utf-8"));
	} catch {
		return null; // absent or unparseable — no usable world
	}
	return isWorldFile(parsed) ? parsed : null;
}

export function writeWorld(world: WorldFile): void {
	fs.mkdirSync(WORLD_FILES.dir, { recursive: true });
	const tmp = path.join(WORLD_FILES.dir, `.topics.json.tmp-${process.pid}`);
	fs.writeFileSync(tmp, `${JSON.stringify(world)}\n`, "utf-8");
	fs.renameSync(tmp, WORLD_FILES.topics);
}

export function appendPlacement(p: Placement): void {
	fs.mkdirSync(WORLD_FILES.dir, { recursive: true });
	fs.appendFileSync(WORLD_FILES.placements, `${JSON.stringify(p)}\n`, "utf-8");
}

export function readPlacements(): Placement[] {
	let raw: string;
	try {
		raw = fs.readFileSync(WORLD_FILES.placements, "utf-8");
	} catch {
		return []; // nothing placed yet
	}
	const out: Placement[] = [];
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		try {
			const v: unknown = JSON.parse(trimmed);
			if (isPlacement(v)) out.push(v);
		} catch {
			// Corrupt line: skip rather than fail the whole read.
		}
	}
	return out;
}

export const worldStore: WorldStore = { readWorld, writeWorld, appendPlacement, readPlacements };
