import type { ForestSnapshot } from "../core/contracts/forest.ts";
import { buildForest } from "../core/forest.ts";
import { graphView } from "./graph.ts";
import { stores } from "./stores.ts";

/**
 * Server-side forest entry (GET /api/forest). A PURE READ: the fixed world and
 * its placements ledger folded through the learner's graph into the forest
 * model (core/forest.ts), plus the slice of the graph the page needs to open
 * an idea. `model` is null when no world file exists (the world has not been
 * built yet); the graph is filled regardless.
 */
export function forestView(): ForestSnapshot {
	const { propositions, chains, sessions, fileSources, nodeSessions } = graphView();
	const graph = { propositions, chains, sessions, fileSources, nodeSessions };
	const world = stores.worldStore.readWorld();
	if (!world) return { model: null, graph };
	return {
		model: buildForest(world, stores.worldStore.readPlacements(), { propositions, chains }),
		graph,
	};
}
