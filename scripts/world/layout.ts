/**
 * One-time world layout: read data/world/topics.json through the Cartographer
 * store, give every topic a position (deterministic, seed 7), write it back.
 *
 *   npm run world:layout
 *
 * Reads and writes under LH_DATA_DIR like the app; `npm run world:layout`
 * preloads scripts/default-data-dir.mjs, so an unset LH_DATA_DIR means the
 * app's own data folder. The resolved folder is printed first. Side effects
 * only when run as the entry point.
 */

import path from "node:path";
import { pathToFileURL } from "node:url";
import { PATHS } from "../../config.ts";
import { layoutWorld } from "../../src/core/world-layout.ts";
import { worldStore } from "../../src/store/world.ts";

const SEED = 7;

function main(): void {
	console.log(`Data folder: ${PATHS.data}`);
	const world = worldStore.readWorld();
	if (!world) throw new Error("No world found. Run `npm run world:generate` first.");
	const topics = layoutWorld(world.topics, SEED);
	worldStore.writeWorld({ ...world, topics });
	console.log(`Laid out ${topics.length} topics.`);
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(path.resolve(entry)).href) {
	try {
		main();
	} catch (e) {
		console.error(e instanceof Error ? e.message : e);
		process.exitCode = 1;
	}
}
