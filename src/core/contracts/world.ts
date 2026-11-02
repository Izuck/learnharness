/**
 * World contracts — the fixed forest of every 4-year BS STEM topic
 *
 * The WORLD is a fixed, generated list of topics (merged across degrees and
 * courses), laid out once. The learner's own graph nodes are PLACED onto world
 * topics by a placer agent; a placement is an append-only ledger line, the
 * latest line per node wins. Pure types only — the logic lives in
 * core/world.ts.
 */

/** One degree programme the world was generated from (e.g. "physics"). */
export interface WorldDegree {
	id: string;
	name: string;
}

/** A topic's resting position in world layout space. */
export interface WorldPosition {
	x: number;
	y: number;
}

/** One topic of the world. The id is topicSlug(name) — the cross-degree
 *  identity key, so the same topic taught in two degrees is ONE topic. */
export interface WorldTopic {
	id: string;
	name: string;
	/** What the topic covers, in a sentence or two. */
	scope: string;
	/** Ids of the degrees that teach this topic, sorted. */
	degrees: string[];
	/** Course names that teach this topic, sorted. */
	courses: string[];
	/** Topic ids this topic builds on, sorted; never itself. */
	prereqs: string[];
	/** Layout position — absent until the layout has run. */
	position?: WorldPosition;
}

/** The generated world file. */
export interface WorldFile {
	version: 1;
	generatedAt: string;
	degrees: WorldDegree[];
	topics: WorldTopic[];
	/** Degree anchors the layout used, derived once from topic overlap at first
	 *  layout; reused afterwards so topics added later anchor consistently and
	 *  pinned positions stay coherent. */
	anchors?: Record<string, WorldPosition>;
}

/** The generator's output for ONE course of ONE degree — the unit that is
 *  merged into the world. Prereqs are topic NAMES here (resolved to ids at
 *  merge). */
export interface CourseTopicsBatch {
	degree: string;
	course: string;
	topics: Array<{ name: string; scope: string; prereqs: string[] }>;
}

/** One placements ledger line: graph node `nodeId` belongs to world topic
 *  `topicId`, or to no topic (`null` — "nothing in the world fits", which is
 *  still a decision). */
export interface Placement {
	nodeId: string;
	topicId: string | null;
	placedAt: string;
}
