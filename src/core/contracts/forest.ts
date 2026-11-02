/**
 * Forest contracts — the learner's view of the world as a fog-of-war forest.
 *
 * The forest is the fixed WORLD (contracts/world.ts) seen through the learner's
 * graph: a topic is lit by the ideas (graph propositions) placed on it, trails
 * between topics are derived from reasoning chains that cross them, and
 * everything else stays fogged. Pure types only — the logic lives in
 * core/forest.ts.
 */

import type { GraphSnapshot } from "./graph.ts";

/** An idea's level-of-knowledge. "fogged" is not a state an idea has — it is
 *  the absence of the idea from the graph. Plan 3 (levelling) supplies the real
 *  states; until then every idea in the graph is "seen". */
export type IdeaState = "seen" | "held" | "fast";

/** How many of a topic's ideas are in each state. */
export interface StateCounts {
	seen: number;
	held: number;
	fast: number;
}

/** One positioned world topic, with the learner's ideas placed on it. */
export interface ForestTopic {
	id: string;
	name: string;
	scope: string;
	degrees: string[];
	x: number;
	y: number;
	/** Node ids placed here, sorted. */
	ideas: string[];
	counts: StateCounts;
	/** 0 = fogged, else (0, 1]; see topicGlow. */
	glow: number;
}

/** A degree's label, at the centroid of its positioned topics. */
export interface ForestRegion {
	degreeId: string;
	name: string;
	x: number;
	y: number;
	/** How many positioned topics list this degree (the region's size). */
	topics: number;
}

/** A path worn between two topics by reasoning chains that cross them. */
export interface ForestTrail {
	/** Topic ids, a < b. */
	a: string;
	b: string;
	/** How many chains join the two topics. */
	chains: number;
	/** The two topics share no degree. */
	crossDegree: boolean;
}

export interface ForestModel {
	/** Positioned topics only, in world order. */
	topics: ForestTopic[];
	regions: ForestRegion[];
	/** Sorted by (a, b). */
	trails: ForestTrail[];
	/** Node ids placed null, or on a topic that is missing or unpositioned; sorted. */
	uncharted: string[];
	/** Live nodes with no placement decision yet. */
	unplaced: number;
	/** World topics with no position (layout not run). */
	unpositioned: number;
	/** Topics with at least one idea / positioned topics. */
	coverage: { mapped: number; total: number };
}

/** The GET /api/forest payload. */
export interface ForestSnapshot {
	/** null = no world file. */
	model: ForestModel | null;
	graph: Pick<GraphSnapshot, "propositions" | "chains" | "sessions" | "fileSources" | "nodeSessions">;
}
