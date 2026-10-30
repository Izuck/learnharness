/**
 * The placer (forest) — a background role that assigns every graph
 * proposition to ONE topic of the fixed world (or to none, `null`), writing
 * the append-only placements ledger the world store owns.
 *
 * It runs AFTER extraction (withPlacement wraps the pipeline's two front
 * doors), never inside it: extraction stays the sole writer of data/graph,
 * and the placer only appends to data/world/placements.jsonl. Unplaced work
 * is derived (live nodes minus placed nodes), so a skipped or failed run
 * simply leaves nodes for the next one — nothing is tracked.
 *
 * Per batch of 20 nodes (sorted by id): each node is offered the 25 topics
 * lexically closest to its text (topicCandidates); the model must answer for
 * exactly the batch, each with one offered topic or null. A node with no
 * candidates is placed null without asking the model. Batches run one
 * submit agent each, inside the shared background-LLM semaphore.
 */

import { Type, type Static } from "typebox";
import type { ModelRole } from "../../../config.ts";
import type { PiEngine } from "../models.ts";
import { getGraph } from "../../core/graph.ts";
import type { GraphStore, WorldStore } from "../../core/ports.ts";
import { mergePlacements, topicCandidates, unplacedNodeIds } from "../../core/world.ts";
import type { WorldTopic } from "../../core/contracts/world.ts";
import type { ExtractionPipeline } from "./extraction.ts";
import { withBgLlmSlot } from "./bg-llm-semaphore.ts";
import { runSubmitAgent } from "./submit-agent.ts";

export interface PlacerDeps {
	graphStore: Pick<GraphStore, "readNodes" | "readChains">;
	worldStore: WorldStore;
	engineFor: (role: ModelRole) => PiEngine | undefined;
	now?: () => string;
}

export interface PlacementStats {
	/** Nodes placed onto a topic. */
	placed: number;
	/** Nodes placed as null (no topic fits, or no candidates at all). */
	uncharted: number;
	/** Unplaced nodes left for a later run (no world, or no model configured). */
	skipped: number;
}

const BATCH_SIZE = 20;
const CANDIDATES_PER_NODE = 25;

const placementsSchema = Type.Object({
	placements: Type.Array(
		Type.Object({
			nodeId: Type.String({ description: "The id of a proposition from the batch, verbatim." }),
			topicId: Type.Union([Type.String(), Type.Null()], {
				description: "The id of the ONE offered topic where this proposition is taught, or null if none fits.",
			}),
		}),
		{ description: "Exactly one entry for every proposition in the batch." },
	),
});
type PlacementsSubmit = Static<typeof placementsSchema>;

export const PLACER_INSTRUCTIONS = `You place propositions onto a fixed map of undergraduate STEM topics.
Each proposition is a general statement of knowledge. Place each one in the single undergraduate topic
where it is taught, choosing only among the topics offered for that proposition, or null if none fits.
Answer with one submit_placements call containing exactly one entry for every proposition in the batch.`;

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function batchPrompt(batch: Array<{ id: string; name: string; statement: string; candidates: WorldTopic[] }>): string {
	return batch
		.map((n) => {
			const offered = n.candidates.map((t) => `  - ${t.id}: ${t.name} — ${clip(t.scope, 160)}`).join("\n");
			return `PROPOSITION ${n.id}\nName: ${n.name}\nStatement: ${n.statement}\nOffered topics:\n${offered}`;
		})
		.join("\n\n");
}

export function createPlacer(deps: PlacerDeps): { placeUnplaced(signal?: AbortSignal): Promise<PlacementStats> } {
	const now = deps.now ?? (() => new Date().toISOString());

	async function runOnce(signal: AbortSignal | undefined): Promise<PlacementStats> {
		const stats: PlacementStats = { placed: 0, uncharted: 0, skipped: 0 };
		const graph = getGraph(deps.graphStore);
		const liveIds = graph.nodes.map((n) => n.id);
		const merged = mergePlacements(deps.worldStore.readPlacements(), new Set(liveIds));
		const unplaced = unplacedNodeIds(liveIds, merged).sort();
		if (unplaced.length === 0) return stats;

		const world = deps.worldStore.readWorld();
		const engine = deps.engineFor("placer");
		if (!world || world.topics.length === 0 || !engine) {
			stats.skipped = unplaced.length;
			return stats;
		}

		const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
		const write = (nodeId: string, topicId: string | null): void => {
			deps.worldStore.appendPlacement({ nodeId, topicId, placedAt: now() });
			if (topicId === null) stats.uncharted++;
			else stats.placed++;
		};

		for (let i = 0; i < unplaced.length; i += BATCH_SIZE) {
			signal?.throwIfAborted();
			const batch: Array<{ id: string; name: string; statement: string; candidates: WorldTopic[] }> = [];
			for (const id of unplaced.slice(i, i + BATCH_SIZE)) {
				const n = nodeById.get(id);
				if (!n) continue;
				const candidates = topicCandidates(`${n.name} ${n.statement}`, world.topics, CANDIDATES_PER_NODE);
				if (candidates.length === 0) write(id, null);
				else batch.push({ id, name: n.name, statement: n.statement, candidates });
			}
			if (batch.length === 0) continue;

			const offered = new Map(batch.map((n) => [n.id, new Set(n.candidates.map((t) => t.id))]));
			// One bad batch must not starve the later ones: a failed batch's
			// nodes stay unplaced (retried on a later run) and the run moves on.
			// Aborts still end the whole run.
			let answer: PlacementsSubmit;
			try {
				answer = await withBgLlmSlot(signal, () =>
					runSubmitAgent<PlacementsSubmit>({
						role: "placer",
						toolName: "submit_placements",
						toolDescription: "Submit one placement per proposition in the batch.",
						parameters: placementsSchema,
						fill: (input) => input as PlacementsSubmit,
						systemPrompt: PLACER_INSTRUCTIONS,
						prompt: batchPrompt(batch),
						engine,
						signal,
						onStep: () => undefined,
						neverSubmitted: "the placer never submitted placements",
						validate: (value) => {
							const seen = new Set<string>();
							for (const p of value.placements) {
								const allowed = offered.get(p.nodeId);
								if (!allowed) return `placements: "${p.nodeId}" is not in this batch.`;
								if (seen.has(p.nodeId)) return `placements: "${p.nodeId}" appears more than once.`;
								seen.add(p.nodeId);
								if (p.topicId !== null && !allowed.has(p.topicId)) {
									return `placements: "${p.topicId}" is not one of the topics offered for "${p.nodeId}" — choose an offered topic id or null.`;
								}
							}
							const missing = batch.find((n) => !seen.has(n.id));
							if (missing) return `placements: "${missing.id}" is missing — answer for every proposition in the batch.`;
							return null;
						},
					}),
				);
			} catch (err) {
				if (signal?.aborted || (err instanceof Error && err.name === "AbortError")) throw err;
				console.warn(
					`[placer] batch starting at ${batch[0]?.id} failed, leaving ${batch.length} node(s) unplaced:`,
					err instanceof Error ? err.message : err,
				);
				stats.skipped += batch.length;
				continue;
			}
			for (const p of answer.placements) write(p.nodeId, p.topicId);
		}
		return stats;
	}

	// Calls run one at a time: a second trigger waits for the first, then
	// re-derives what is unplaced, so no node is ever placed twice.
	let tail: Promise<unknown> = Promise.resolve();
	return {
		placeUnplaced(signal) {
			const run = tail.then(() => runOnce(signal));
			tail = run.catch(() => undefined);
			return run;
		},
	};
}

/** Wrap the extraction pipeline so each successful run kicks off placement
 *  in the background. A failed run places nothing (and still rejects); a
 *  failing placer never fails the extraction. */
export function withPlacement(pipeline: ExtractionPipeline, placer: ReturnType<typeof createPlacer>): ExtractionPipeline {
	const place = <T>(stats: T): T => {
		void placer.placeUnplaced().catch((err: unknown) => {
			console.warn("[placer] placement failed:", err instanceof Error ? err.message : err);
		});
		return stats;
	};
	return {
		runExtraction: (chatId) => pipeline.runExtraction(chatId).then(place),
		importNotes: (input) => pipeline.importNotes(input).then(place),
	};
}
