/**
 * One-time world layout: read data/world/topics.json through the Cartographer
 * store, give every topic a position (deterministic, seed 7), write it back.
 *
 *   npm run world:layout [-- --dry-run] [--partial]
 *
 * Degree anchors: if topics.json already holds `anchors`, they are reused
 * as-is (a degree missing from them falls back to its hand-drawn anchor, and
 * is named in one line); they are never re-derived, so topics added later
 * anchor consistently with the pinned ones. Otherwise they are derived from
 * the topics' degree overlap (classical MDS, aligned to the hand-drawn map),
 * printed with the 2D/3D distortion (stress) of that embedding, laid out with,
 * and stored in topics.json. A degree with too few topics to derive keeps its
 * hand-drawn anchor for good, so deriving while any degree is still
 * ungenerated refuses to write unless --partial is passed. A world laid out
 * before anchors were stored keeps the hand-drawn anchors its positions used.
 *
 * --dry-run does everything except write: it prints what would be stored and
 * the stress.
 *
 * Reads and writes under LH_DATA_DIR like the app; `npm run world:layout`
 * preloads scripts/default-data-dir.mjs, so an unset LH_DATA_DIR means the
 * app's own data folder. The resolved folder is printed first. Side effects
 * only when run as the entry point.
 */

import path from "node:path";
import { pathToFileURL } from "node:url";
import { PATHS } from "../../config.ts";
import type { WorldPosition } from "../../src/core/contracts/world.ts";
import { deriveDegreeAnchors } from "../../src/core/world-anchors.ts";
import { DEGREE_ANCHORS, layoutWorld } from "../../src/core/world-layout.ts";
import { worldStore } from "../../src/store/world.ts";

const SEED = 7;

/** Stress < 0.1 is a good fit, 0.1–0.2 fair, above 0.2 poor. */
function readStress(s: number): string {
	return s < 0.1 ? "good" : s <= 0.2 ? "fair" : "poor";
}

function printTable(anchors: Record<string, WorldPosition>, derived: readonly string[]): void {
	const ids = Object.keys(anchors).sort();
	const width = Math.max(6, ...ids.map((id) => id.length));
	console.log(`${"degree".padEnd(width)}  status   ${"x".padStart(8)} ${"y".padStart(8)}`);
	for (const id of ids) {
		const a = anchors[id]!;
		const status = derived.includes(id) ? "derived" : "kept   ";
		console.log(`${id.padEnd(width)}  ${status}  ${a.x.toFixed(0).padStart(8)} ${a.y.toFixed(0).padStart(8)}`);
	}
}

function printMinDistance(anchors: Record<string, WorldPosition>): void {
	const ids = Object.keys(anchors).sort();
	let best: { a: string; b: string; d: number } | null = null;
	for (let i = 0; i < ids.length; i++) {
		for (let j = i + 1; j < ids.length; j++) {
			const p = anchors[ids[i]!]!;
			const q = anchors[ids[j]!]!;
			const d = Math.hypot(p.x - q.x, p.y - q.y);
			if (!best || d < best.d) best = { a: ids[i]!, b: ids[j]!, d };
		}
	}
	if (best) console.log(`Minimum anchor distance: ${best.d.toFixed(0)} (${best.a} - ${best.b})`);
}

function main(): void {
	console.log(`Data folder: ${PATHS.data}`);
	const dryRun = process.argv.slice(2).includes("--dry-run");
	const partial = process.argv.slice(2).includes("--partial");
	const world = worldStore.readWorld();
	if (!world) throw new Error("No world found. Run `npm run world:generate` first.");

	let anchors: Record<string, WorldPosition>;
	if (world.anchors) {
		const missing = Object.keys(DEGREE_ANCHORS)
			.filter((d) => !(d in world.anchors!))
			.sort();
		anchors = { ...DEGREE_ANCHORS, ...world.anchors };
		console.log(
			missing.length > 0
				? `Reusing stored anchors; hand-drawn anchors fill in: ${missing.join(", ")}.`
				: "Reusing stored anchors.",
		);
		printMinDistance(anchors);
	} else if (world.topics.some((t) => t.position)) {
		// Laid out before anchors were stored: those positions were settled
		// around the hand-drawn anchors, so keep them rather than re-derive.
		anchors = { ...DEGREE_ANCHORS };
		console.log("Topics are already positioned but no anchors are stored; keeping the hand-drawn anchors.");
	} else {
		const result = deriveDegreeAnchors(world.topics, DEGREE_ANCHORS);
		if (result.kept.length > 0 && !dryRun && !partial) {
			throw new Error(
				`Too little data to place from topic overlap: ${result.kept.join(", ")}. Laying out now fixes their anchors at the hand-drawn spots for good.\n` +
					"Generate them first (npm run world:generate), preview with --dry-run, or pass --partial to accept that.",
			);
		}
		anchors = result.anchors;
		printTable(anchors, result.derived);
		if (result.stress) {
			const { d2, d3 } = result.stress;
			console.log(`Distortion: 2D stress ${d2.toFixed(3)}, 3D stress ${d3.toFixed(3)}`);
			const better = d2 - d3 > 0.05 ? "3D is meaningfully better" : "3D would not help much";
			console.log(`A flat map fits the topic overlap ${readStress(d2)} (<0.1 good, 0.1-0.2 fair, >0.2 poor); ${better}.`);
		} else {
			console.log("Distortion: not measured (fewer than 3 degrees have enough topics; hand-drawn anchors kept).");
		}
		printMinDistance(anchors);
	}

	const topics = layoutWorld(world.topics, SEED, anchors);
	if (dryRun) {
		console.log(`Dry run: nothing written. Would lay out ${topics.length} topics and store anchors:`);
		console.log(JSON.stringify(anchors));
		return;
	}
	worldStore.writeWorld({ ...world, topics, anchors });
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
