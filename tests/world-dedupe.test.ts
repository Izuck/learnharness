// WORLD DEDUPE — pinned behaviors:
// 1. NORMALISER: case, stop words, "introduction", plurals, word order and
//    punctuation do not change a topic's key; real differences do.
// 2. CANDIDATES: exact key collisions plus fuzzy (Jaccard >= 0.6) pairs that
//    share no course, unioned into groups capped at 6, deterministic.
// 3. ALIASES: only same:true decisions whose members exist; chains resolve,
//    cycles break deterministically.
// 4. MERGE: aliases fold names, degrees, courses and prereqs into the
//    canonical topic; with no aliases the output is unchanged.
// 5. PLACEMENTS: a node whose latest placement is a merged-away topic gets a
//    NEW line at the canonical (the ledger is never rewritten).
// 6. SCRIPT: one end-to-end run with a fake ask, plus idempotence.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { runClaudeJson } from "../scripts/world/claude-cli.ts";
import { buildWorld, readMerges } from "../scripts/world/build-world.ts";
import { dedupeWorld } from "../scripts/world/dedupe.ts";
import type {
	CourseTopicsBatch,
	Placement,
	TopicMerges,
	WorldFile,
	WorldTopic,
} from "../src/core/contracts/world.ts";
import type { WorldStore } from "../src/core/ports.ts";
import {
	activeMerges,
	aliasMap,
	canonicalNameMap,
	decisionKey,
	dedupeCandidates,
	mergeCollisions,
	mergeDegreeTopics,
	normaliseTopicName,
	repointPlacements,
} from "../src/core/world.ts";

const topic = (name: string, courses: string[] = [], over: Partial<WorldTopic> = {}): WorldTopic => ({
	id: name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, ""),
	name,
	scope: "",
	degrees: ["d"],
	courses,
	prereqs: [],
	...over,
});

const decision = (
	same: boolean,
	canonical?: string,
	decidedAt = "2026-01-01T00:00:00.000Z",
): TopicMerges["decisions"][string] => ({
	same,
	...(canonical === undefined ? {} : { canonical }),
	reason: "r",
	decidedAt,
});

describe("normaliseTopicName", () => {
	it("ignores case, plurals, stop words and word order", () => {
		const k = normaliseTopicName("Bipolar Junction Transistor");
		assert.equal(normaliseTopicName("bipolar junction transistors"), k);
		assert.equal(
			normaliseTopicName("Searching and Sorting Algorithms"),
			normaliseTopicName("Algorithms: Searching and Sorting"),
		);
		assert.equal(
			normaliseTopicName("Atmospheric Composition and Structure"),
			normaliseTopicName("Atmospheric Structure and Composition"),
		);
	});

	it("drops 'introduction' filler", () => {
		assert.equal(normaliseTopicName("Introduction to Biotechnology"), normaliseTopicName("Biotechnology"));
		assert.equal(normaliseTopicName("An Introduction to Biotechnology"), "biotechnology");
	});

	it("strips possessives and punctuation", () => {
		assert.equal(normaliseTopicName("Newton's Laws of Motion"), normaliseTopicName("Newtons Laws, Motion"));
	});

	it("handles -ies and -es plurals but not -ss/-us/-is endings", () => {
		assert.equal(normaliseTopicName("Boundary Conditions"), normaliseTopicName("Boundary Condition"));
		assert.equal(normaliseTopicName("Fourier Series"), "fourier series");
		assert.equal(normaliseTopicName("Analysis"), "analysis");
		assert.equal(normaliseTopicName("Stress"), "stress");
		assert.equal(normaliseTopicName("Taxes"), normaliseTopicName("Tax"));
		assert.equal(normaliseTopicName("Probabilities"), normaliseTopicName("Probability"));
	});

	it("keeps real differences apart, including numerals and grain", () => {
		assert.notEqual(normaliseTopicName("Calculus I"), normaliseTopicName("Calculus"));
		assert.notEqual(normaliseTopicName("Fourier Series"), normaliseTopicName("Fourier Analysis"));
		assert.notEqual(normaliseTopicName("Fourier Transform"), normaliseTopicName("Fourier Transform Properties"));
	});

	it("is empty for a name made only of filler", () => {
		assert.equal(normaliseTopicName("Introduction to the"), "");
	});
});

describe("dedupeCandidates", () => {
	it("groups exact normalised-key collisions", () => {
		const topics = [
			topic("Bipolar Junction Transistor", ["EE1"]),
			topic("Bipolar Junction Transistors", ["EE2"]),
			topic("Biotechnology", ["B1"]),
			topic("Introduction to Biotechnology", ["B2"]),
			topic("Heat Transfer", ["M1"]),
		];
		assert.deepEqual(dedupeCandidates(topics), [
			["biotechnology", "introduction-to-biotechnology"],
			["bipolar-junction-transistor", "bipolar-junction-transistors"],
		]);
	});

	it("finds looser fuzzy pairs by Jaccard >= 0.6", () => {
		// {fourier, transform} vs {fourier, transform, property} = 2/3
		const topics = [
			topic("Fourier Transform", ["S1"]),
			topic("The Fourier Transform and Its Properties", ["P1"]),
			topic("Fourier Series", ["S1"]),
		];
		assert.deepEqual(dedupeCandidates(topics), [["fourier-transform", "the-fourier-transform-and-its-properties"]]);
	});

	it("keeps different-grain topics apart (Jaccard below the threshold)", () => {
		const topics = [topic("Fourier Series", ["A"]), topic("Fourier Analysis", ["B"]), topic("Fourier Transform", ["C"])];
		assert.deepEqual(dedupeCandidates(topics), []);
	});

	it("honours a custom threshold", () => {
		const topics = [topic("Fourier Series", ["A"]), topic("Fourier Analysis", ["B"])];
		assert.deepEqual(dedupeCandidates(topics, { threshold: 0.3 }), [["fourier-analysis", "fourier-series"]]);
	});

	it("excludes fuzzy pairs that share a course", () => {
		const topics = [
			topic("Fourier Transform", ["Signals"]),
			topic("The Fourier Transform and Its Properties", ["Signals", "Math"]),
		];
		assert.deepEqual(dedupeCandidates(topics), []);
	});

	it("unions overlapping pairs into one group", () => {
		const topics = [
			topic("Binary Search Tree Insertion", ["A"]),
			topic("Binary Search Tree Deletion", ["B"]),
			topic("Binary Search Tree Traversal", ["C"]),
		];
		// pairwise 3/5 = 0.6
		assert.deepEqual(dedupeCandidates(topics), [
			["binary-search-tree-deletion", "binary-search-tree-insertion", "binary-search-tree-traversal"],
		]);
	});

	it("caps groups at 6 members, best pairs first, and loses no member", () => {
		const topics: WorldTopic[] = [];
		for (let i = 0; i < 8; i++) topics.push(topic(`Gradient Descent Variant ${i + 1}`, [`C${i}`]));
		const groups = dedupeCandidates(topics, { threshold: 0.6 });
		assert.ok(groups.length >= 1);
		for (const g of groups) {
			assert.ok(g.length >= 2 && g.length <= 6, `group size ${g.length}`);
			assert.deepEqual(g, [...g].sort());
		}
		assert.ok(groups.some((g) => g.length === 6));
		// no id appears in two groups
		const all = groups.flat();
		assert.equal(new Set(all).size, all.length);
		// a smaller cap is respected
		for (const g of dedupeCandidates(topics, { maxGroup: 3 })) assert.ok(g.length <= 3);
	});

	it("prefers exact-key pairs over fuzzy ones when splitting", () => {
		const topics = [
			topic("Gradient Descent Method", ["A"]),
			topic("Gradient Descent Methods", ["B"]),
			topic("Gradient Descent Method Analysis", ["C"]),
		];
		const [g] = dedupeCandidates(topics, { maxGroup: 2 });
		assert.deepEqual(g, ["gradient-descent-method", "gradient-descent-methods"]);
	});

	it("is deterministic whatever the input order", () => {
		const topics = [
			topic("Bipolar Junction Transistor", ["EE1"]),
			topic("Bipolar Junction Transistors", ["EE2"]),
			topic("Searching and Sorting Algorithms", ["CS1"]),
			topic("Algorithms: Searching and Sorting", ["CS2"]),
			topic("Fourier Transform", ["S1"]),
			topic("The Fourier Transform and Its Properties", ["P1"]),
		];
		const a = dedupeCandidates(topics);
		const b = dedupeCandidates([...topics].reverse());
		assert.equal(JSON.stringify(a), JSON.stringify(b));
		assert.equal(a.length, 3);
	});

	it("ignores topics whose name normalises to nothing", () => {
		assert.deepEqual(dedupeCandidates([topic("Introduction", ["A"]), topic("Introduction to", ["B"])]), []);
	});
});

describe("aliasMap", () => {
	const ids = new Set(["a", "b", "c", "d"]);
	const merges = (decisions: TopicMerges["decisions"]): TopicMerges => ({ version: 1, decisions });

	it("maps merged-away ids to the canonical id", () => {
		const m = aliasMap(merges({ "a|b": decision(true, "B") }), ids);
		assert.deepEqual([...m], [["a", "b"]]);
	});

	it("ignores same:false decisions", () => {
		assert.equal(aliasMap(merges({ "a|b": decision(false) }), ids).size, 0);
	});

	it("resolves chains transitively", () => {
		const m = aliasMap(
			merges({
				"a|b": decision(true, "b", "2026-01-01T00:00:00.000Z"),
				"b|c": decision(true, "c", "2026-01-02T00:00:00.000Z"),
			}),
			ids,
		);
		assert.equal(m.get("a"), "c");
		assert.equal(m.get("b"), "c");
		assert.equal(m.has("c"), false);
	});

	it("breaks cycles deterministically: the smallest id of the cycle is the root", () => {
		const m1 = aliasMap(merges({ "a|b": decision(true, "b"), "b|c": decision(true, "c"), "a|c": decision(true, "a") }), ids);
		const m2 = aliasMap(merges({ "a|c": decision(true, "a"), "b|c": decision(true, "c"), "a|b": decision(true, "b") }), ids);
		assert.equal(JSON.stringify([...m1].sort()), JSON.stringify([...m2].sort()));
		for (const [from, to] of m1) {
			assert.notEqual(from, to);
			assert.equal(m1.has(to), false, "targets are final");
		}
		assert.equal(m1.size, 2);
	});

	it("ignores decisions whose members no longer exist", () => {
		const m = aliasMap(merges({ "a|zzz": decision(true, "a"), "c|d": decision(true, "d") }), ids);
		assert.deepEqual([...m], [["c", "d"]]);
	});

	it("accepts a decision on a canonical id coined by an earlier decision", () => {
		// "Coined Name" is not a topic; a|b merge into it, then it merges with c.
		const m = aliasMap(
			merges({
				"a|b": decision(true, "Coined Name", "2026-01-01T00:00:00.000Z"),
				"c|coined-name": decision(true, "c", "2026-01-02T00:00:00.000Z"),
			}),
			ids,
		);
		assert.equal(m.get("a"), "c");
		assert.equal(m.get("b"), "c");
		assert.equal(m.get("coined-name"), "c");
	});

	it("ignores a same:true decision with no usable canonical", () => {
		assert.equal(aliasMap(merges({ "a|b": decision(true), "c|d": decision(true, "  ") }), ids).size, 0);
	});

	it("skips a decision whose canonical is a raw topic that is not a member", () => {
		const d = merges({ "a|b": decision(true, "D") });
		assert.equal(aliasMap(d, ids).size, 0);
		assert.deepEqual(activeMerges(d, ids), []);
		assert.deepEqual(mergeCollisions(d, ids).map((m) => m.key), ["a|b"]);
		// a member canonical is fine
		assert.equal(aliasMap(merges({ "a|b": decision(true, "B") }), ids).size, 1);
	});

	it("skips a later decision that coins the same canonical as an unrelated earlier one", () => {
		const m = merges({
			"a|b": decision(true, "Heat Transfer", "2026-01-01T00:00:00.000Z"),
			"c|d": decision(true, "Heat Transfer", "2026-01-02T00:00:00.000Z"),
		});
		assert.deepEqual([...aliasMap(m, ids)].sort(), [
			["a", "heat-transfer"],
			["b", "heat-transfer"],
		]);
		assert.deepEqual(mergeCollisions(m, ids).map((x) => x.key), ["c|d"]);
	});

	it("lets decisions sharing a member use the same canonical", () => {
		const m = merges({
			"a|b": decision(true, "A", "2026-01-01T00:00:00.000Z"),
			"a|c": decision(true, "A", "2026-01-02T00:00:00.000Z"),
		});
		assert.deepEqual([...aliasMap(m, ids)].sort(), [
			["b", "a"],
			["c", "a"],
		]);
		assert.deepEqual(mergeCollisions(m, ids), []);
	});

	it("has canonical names for the targets", () => {
		const names = canonicalNameMap(merges({ "a|b": decision(true, "  The B Name ") }), ids);
		assert.equal(names.get("the-b-name"), "The B Name");
	});
});

describe("decisionKey", () => {
	it("sorts and joins with a pipe", () => {
		assert.equal(decisionKey(["b", "a", "c"]), "a|b|c");
	});
});

describe("mergeDegreeTopics with aliases", () => {
	const batches: CourseTopicsBatch[] = [
		{
			degree: "ee",
			course: "Electronics",
			topics: [
				{ name: "Bipolar Junction Transistors", scope: "BJT physics", prereqs: ["Diodes"] },
				{ name: "Diodes", scope: "pn junctions", prereqs: [] },
			],
		},
		{
			degree: "physics",
			course: "Solid State",
			topics: [
				{ name: "Bipolar Junction Transistor", scope: "BJT operation", prereqs: ["Bipolar Junction Transistors"] },
				{ name: "Amplifiers", scope: "gain", prereqs: ["Bipolar Junction Transistors", "Diodes"] },
			],
		},
	];
	const aliases = new Map([["bipolar-junction-transistors", "bipolar-junction-transistor"]]);

	it("is unchanged with no aliases (or an empty map)", () => {
		const base = mergeDegreeTopics(batches);
		assert.equal(JSON.stringify(mergeDegreeTopics(batches, new Map())), JSON.stringify(base));
		assert.equal(JSON.stringify(mergeDegreeTopics(batches, undefined)), JSON.stringify(base));
	});

	it("unions degrees, courses, scopes and prereqs into the canonical topic", () => {
		const { topics } = mergeDegreeTopics(batches, aliases);
		assert.equal(topics.some((t) => t.id === "bipolar-junction-transistors"), false);
		const bjt = topics.find((t) => t.id === "bipolar-junction-transistor");
		assert.deepEqual(bjt?.degrees, ["ee", "physics"]);
		assert.deepEqual(bjt?.courses, ["Electronics", "Solid State"]);
		assert.equal(bjt?.scope, "BJT operation; BJT physics");
		assert.deepEqual(bjt?.prereqs, ["diodes"]);
	});

	it("never lists a topic as its own prereq after folding", () => {
		const { topics } = mergeDegreeTopics(batches, aliases);
		const bjt = topics.find((t) => t.id === "bipolar-junction-transistor");
		assert.equal(bjt?.prereqs.includes("bipolar-junction-transistor"), false);
	});

	it("resolves a prereq that points at an alias to the canonical id", () => {
		const { topics } = mergeDegreeTopics(batches, aliases);
		const amp = topics.find((t) => t.id === "amplifiers");
		assert.deepEqual(amp?.prereqs, ["bipolar-junction-transistor", "diodes"]);
	});

	it("gives the canonical topic the canonical name", () => {
		const names = new Map([["bipolar-junction-transistor", "Bipolar Junction Transistor (BJT)"]]);
		const { topics } = mergeDegreeTopics(batches, aliases, names);
		assert.equal(topics.find((t) => t.id === "bipolar-junction-transistor")?.name, "Bipolar Junction Transistor (BJT)");
	});

	it("builds a canonical topic that no batch names directly", () => {
		const al = new Map([
			["bipolar-junction-transistors", "bjt"],
			["bipolar-junction-transistor", "bjt"],
		]);
		const { topics } = mergeDegreeTopics(batches, al, new Map([["bjt", "BJT"]]));
		const bjt = topics.find((t) => t.id === "bjt");
		assert.equal(bjt?.name, "BJT");
		assert.deepEqual(bjt?.degrees, ["ee", "physics"]);
		assert.deepEqual(topics.find((t) => t.id === "amplifiers")?.prereqs, ["bjt", "diodes"]);
	});

	it("is independent of batch order", () => {
		const a = mergeDegreeTopics(batches, aliases);
		const b = mergeDegreeTopics([...batches].reverse(), aliases);
		assert.equal(JSON.stringify(a), JSON.stringify(b));
	});
});

describe("repointPlacements", () => {
	const aliases = new Map([
		["old", "new"],
		["older", "new"],
	]);
	const at = "2026-02-02T00:00:00.000Z";

	it("emits one new line per node whose latest placement is merged away", () => {
		const latest = new Map<string, string | null>([
			["n2", "old"],
			["n1", "older"],
			["n3", "fine"],
			["n4", null],
		]);
		assert.deepEqual(repointPlacements(latest, aliases, at), [
			{ nodeId: "n1", topicId: "new", placedAt: at },
			{ nodeId: "n2", topicId: "new", placedAt: at },
		]);
	});

	it("emits nothing when nothing is merged away (idempotent once repointed)", () => {
		assert.deepEqual(repointPlacements(new Map([["n1", "new"]]), aliases, at), []);
		assert.deepEqual(repointPlacements(new Map([["n1", "old"]]), new Map(), at), []);
	});
});

// ─── the script, end to end, with a fake ask ────────────────────────────────

let buildDir = "";
beforeEach(() => {
	buildDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-world-dedupe-"));
});
afterEach(() => {
	fs.rmSync(buildDir, { recursive: true, force: true });
});

function writeBatch(b: CourseTopicsBatch): void {
	const dir = path.join(buildDir, b.degree);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, `${b.course.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.json`), JSON.stringify(b));
}

function memStore(initial: WorldFile | null = null, placements: Placement[] = []) {
	const state = { world: initial, placements: [...placements], writes: 0 };
	const store: WorldStore = {
		readWorld: () => state.world,
		writeWorld: (w) => {
			state.world = w;
			state.writes++;
		},
		appendPlacement: (p) => void state.placements.push(p),
		readPlacements: () => [...state.placements],
	};
	return { store, state };
}

const bt = (name: string, prereqs: string[] = []) => ({ name, scope: `About ${name}.`, prereqs });

function seedBatches(): void {
	writeBatch({
		degree: "ee",
		course: "Electronics",
		topics: [bt("Bipolar Junction Transistors"), bt("Diodes"), bt("Biotech Lab Safety")],
	});
	writeBatch({
		degree: "physics",
		course: "Solid State",
		topics: [bt("Bipolar Junction Transistor"), bt("Amplifiers", ["Bipolar Junction Transistors"])],
	});
	writeBatch({
		degree: "biology",
		course: "Genetics",
		topics: [bt("Biotechnology"), bt("Binary Search")],
	});
	writeBatch({
		degree: "chemistry",
		course: "Analytical",
		topics: [bt("Introduction to Biotechnology"), bt("Binary Search Trees")],
	});
}

/** A fake ask that judges every group by a rule and records its prompts. */
function fakeAsk(
	judge: (names: string[]) => { same: boolean; canonical?: string; reason?: string; members?: number[] } | null,
	prompts: string[] = [],
): typeof runClaudeJson {
	return (async (o: { prompt: string }) => {
		prompts.push(o.prompt);
		const decisions: unknown[] = [];
		for (const block of o.prompt.split(/^Group /m).slice(1)) {
			const group = Number(/^(\d+)/.exec(block)?.[1]);
			const names = [...block.matchAll(/^- \(\d+\) "(.+?)"/gm)].map((m) => m[1] as string);
			const v = judge(names);
			if (!v) continue;
			decisions.push({ group, same: v.same, members: v.members ?? [], canonical: v.canonical ?? "", reason: v.reason ?? "because" });
		}
		return { decisions };
	}) as unknown as typeof runClaudeJson;
}

const sameIfBiotechOrBjt = (names: string[]) => {
	if (names.some((n) => /transistor/i.test(n))) return { same: true, canonical: "Bipolar Junction Transistor" };
	if (names.some((n) => /biotech/i.test(n))) return { same: true, canonical: "Biotechnology" };
	return { same: false, reason: "different grain" };
};

describe("dedupeWorld", () => {
	const common = () => {
		const mergesFile = path.join(buildDir, "merges.json");
		const reportFile = path.join(buildDir, "WORLD.md");
		return { buildDir, mergesFile, reportFile };
	};

	it("asks about undecided groups, saves merges, rebuilds the world and repoints placements", async () => {
		seedBatches();
		const { store, state } = memStore(null, [
			{ nodeId: "n1", topicId: "bipolar-junction-transistors", placedAt: "2026-01-01T00:00:00.000Z" },
			{ nodeId: "n2", topicId: "diodes", placedAt: "2026-01-01T00:00:00.000Z" },
			{ nodeId: "n3", topicId: "bipolar-junction-transistors", placedAt: "2026-01-01T00:00:00.000Z" },
			{ nodeId: "n3", topicId: "diodes", placedAt: "2026-01-02T00:00:00.000Z" },
		]);
		const prompts: string[] = [];
		const summary = await dedupeWorld({
			...common(),
			store,
			ask: fakeAsk(sameIfBiotechOrBjt, prompts),
			log: () => {},
			now: () => "2026-03-03T00:00:00.000Z",
		});

		assert.equal(prompts.length, 1);
		assert.match(prompts[0] as string, /Bipolar Junction Transistors/);
		assert.equal(summary.newlyDecided, 3);
		assert.equal(summary.merged, 2);
		assert.equal(summary.keptSeparate, 1);

		// merges.json holds every judged group
		const merges = JSON.parse(fs.readFileSync(path.join(buildDir, "merges.json"), "utf-8")) as TopicMerges;
		assert.equal(merges.version, 1);
		assert.deepEqual(Object.keys(merges.decisions).sort(), [
			"biotechnology|introduction-to-biotechnology",
			"bipolar-junction-transistor|bipolar-junction-transistors",
			"binary-search|binary-search-trees",
		].sort());
		assert.equal(merges.decisions["binary-search|binary-search-trees"]?.same, false);

		// topics.json folded
		const ids = (state.world?.topics ?? []).map((t) => t.id);
		assert.equal(ids.includes("bipolar-junction-transistors"), false);
		assert.equal(ids.includes("introduction-to-biotechnology"), false);
		assert.equal(ids.includes("binary-search"), true);
		const bjt = state.world?.topics.find((t) => t.id === "bipolar-junction-transistor");
		assert.deepEqual(bjt?.degrees, ["ee", "physics"]);
		assert.deepEqual(state.world?.topics.find((t) => t.id === "amplifiers")?.prereqs, ["bipolar-junction-transistor"]);
		assert.equal(summary.topicsBefore, 9);
		assert.equal(summary.topicsAfter, 7);
		assert.equal(summary.sharedBefore, 0);
		assert.equal(summary.sharedAfter, 2);

		// placements: n1 repointed (new line), n2 untouched, n3's latest is diodes
		const added = state.placements.slice(4);
		assert.deepEqual(added, [{ nodeId: "n1", topicId: "bipolar-junction-transistor", placedAt: "2026-03-03T00:00:00.000Z" }]);
		assert.equal(state.placements.length, 5, "ledger only appended to");

		// reports written
		assert.ok(fs.existsSync(path.join(buildDir, "WORLD.md")));
		const md = fs.readFileSync(path.join(buildDir, "merges.md"), "utf-8");
		assert.match(md, /Bipolar Junction Transistor/);
		assert.match(md, /Bipolar Junction Transistors/);
		assert.match(md, /different grain/);
	});

	it("is idempotent: a rerun asks nothing and changes nothing", async () => {
		seedBatches();
		const { store, state } = memStore();
		await dedupeWorld({ ...common(), store, ask: fakeAsk(sameIfBiotechOrBjt), log: () => {} });
		const worldBefore = JSON.stringify({ ...state.world, generatedAt: "" });
		const mergesBefore = fs.readFileSync(path.join(buildDir, "merges.json"), "utf-8");
		const prompts: string[] = [];
		const again = await dedupeWorld({ ...common(), store, ask: fakeAsk(sameIfBiotechOrBjt, prompts), log: () => {} });
		assert.equal(prompts.length, 0);
		assert.equal(again.newlyDecided, 0);
		assert.equal(JSON.stringify({ ...state.world, generatedAt: "" }), worldBefore);
		assert.equal(fs.readFileSync(path.join(buildDir, "merges.json"), "utf-8"), mergesBefore);
		assert.equal(state.placements.length, 0);
	});

	it("copes with batches appearing between runs: only the new group is asked", async () => {
		seedBatches();
		const { store } = memStore();
		await dedupeWorld({ ...common(), store, ask: fakeAsk(sameIfBiotechOrBjt), log: () => {} });
		writeBatch({
			degree: "me",
			course: "Heat",
			topics: [bt("Heat Transfer"), bt("Heat Transfers")],
		});
		const prompts: string[] = [];
		const again = await dedupeWorld({
			...common(),
			store,
			ask: fakeAsk(() => ({ same: true, canonical: "Heat Transfer" }), prompts),
			log: () => {},
		});
		// "Heat Transfer" and "Heat Transfers" share a course, but they collide by
		// key (exact collisions are not excluded by course).
		assert.equal(prompts.length, 1);
		assert.equal(again.newlyDecided, 1);
		assert.doesNotMatch(prompts[0] as string, /Biotechnology/);
	});

	it("leaves groups the model skipped undecided for the next run", async () => {
		seedBatches();
		const { store } = memStore();
		const s = await dedupeWorld({
			...common(),
			store,
			ask: fakeAsk((names) => (names.some((n) => /transistor/i.test(n)) ? { same: true, canonical: "Bipolar Junction Transistor" } : null)),
			log: () => {},
		});
		assert.equal(s.newlyDecided, 1);
		const merges = JSON.parse(fs.readFileSync(path.join(buildDir, "merges.json"), "utf-8")) as TopicMerges;
		assert.equal(Object.keys(merges.decisions).length, 1);
		const prompts: string[] = [];
		await dedupeWorld({ ...common(), store, ask: fakeAsk(sameIfBiotechOrBjt, prompts), log: () => {} });
		assert.equal(prompts.length, 1);
		assert.doesNotMatch(prompts[0] as string, /Transistor/);
	});

	it("merges a subset of a mixed group, then really asks again about the rest plus the merged topic", async () => {
		writeBatch({
			degree: "earth-space",
			course: "Climate",
			topics: [bt("Climate Change"), bt("Abrupt Climate Change")],
		});
		writeBatch({ degree: "env", course: "Atmosphere", topics: [bt("Climate and Climate Change")] });
		const { store, state } = memStore();
		const prompts: string[] = [];
		const judge = (names: string[]) => {
			if (names.length !== 3) return { same: false, reason: "different grain" };
			const a = names.indexOf("Climate Change") + 1;
			const b = names.indexOf("Climate and Climate Change") + 1;
			return { same: true, members: [a, b], canonical: "Climate Change", reason: "same" };
		};
		const s = await dedupeWorld({ ...common(), store, ask: fakeAsk(judge, prompts), log: () => {} });
		// pass 1: the 3-group. The merged topic now shares the course "Climate"
		// with "Abrupt Climate Change", so the fuzzy filter alone would drop the
		// pair; pass 2 asks about it because it is re-offered explicitly.
		assert.equal(prompts.length, 2);
		assert.match(prompts[1] as string, /"Abrupt Climate Change"/);
		assert.match(prompts[1] as string, /"Climate Change"/);
		assert.doesNotMatch(prompts[1] as string, /"Climate and Climate Change"/);
		const merges = JSON.parse(fs.readFileSync(path.join(buildDir, "merges.json"), "utf-8")) as TopicMerges;
		assert.equal(merges.decisions["climate-and-climate-change|climate-change"]?.same, true);
		assert.equal(merges.decisions["abrupt-climate-change|climate-change"]?.same, false);
		assert.equal(s.merged, 1);
		assert.equal(s.keptSeparate, 1);
		const ids = (state.world?.topics ?? []).map((t) => t.id);
		assert.deepEqual(ids, ["abrupt-climate-change", "climate-change"]);
	});

	describe("passes", () => {
		const variants = (): void => {
			for (let i = 1; i <= 6; i++) {
				writeBatch({ degree: "cs", course: `Course ${i}`, topics: [bt(`Gradient Descent Variant ${i}`)] });
			}
		};
		// Always merge the first two listed members and keep the first one's name,
		// so a group of n becomes one of n-1 and is offered again.
		const mergeFirstTwo = (names: string[]) => ({ same: true, members: [1, 2], canonical: names[0], reason: "same" });

		it("keeps going until the leftovers are all folded in", async () => {
			variants();
			const { store, state } = memStore();
			const prompts: string[] = [];
			await dedupeWorld({ ...common(), store, ask: fakeAsk(mergeFirstTwo, prompts), log: () => {} });
			assert.equal(prompts.length, 5);
			assert.equal(state.world?.topics.length, 1);
		});

		it("stops at maxPasses, leaving the rest for the next run", async () => {
			variants();
			const { store, state } = memStore();
			const prompts: string[] = [];
			const s = await dedupeWorld({ ...common(), store, ask: fakeAsk(mergeFirstTwo, prompts), log: () => {}, maxPasses: 3 });
			assert.equal(prompts.length, 3);
			assert.equal(state.world?.topics.length, 3);
			assert.equal(s.undecided >= 1, true);
			// the next run resumes where it stopped
			const more: string[] = [];
			await dedupeWorld({ ...common(), store, ask: fakeAsk(mergeFirstTwo, more), log: () => {}, maxPasses: 3 });
			assert.equal(more.length >= 1, true);
		});
	});

	it("never overwrites an existing decision with a subset verdict", async () => {
		writeBatch({ degree: "earth-space", course: "Climate", topics: [bt("Climate Change"), bt("Abrupt Climate Change")] });
		writeBatch({ degree: "env", course: "Atmosphere", topics: [bt("Climate and Climate Change")] });
		fs.writeFileSync(
			path.join(buildDir, "merges.json"),
			JSON.stringify({ version: 1, decisions: { "climate-and-climate-change|climate-change": decision(false) } }),
		);
		const { store } = memStore();
		const logs: string[] = [];
		const judge = (names: string[]) => {
			if (names.length !== 3) return { same: false };
			return {
				same: true,
				members: [names.indexOf("Climate Change") + 1, names.indexOf("Climate and Climate Change") + 1],
				canonical: "Climate Change",
			};
		};
		const s = await dedupeWorld({ ...common(), store, ask: fakeAsk(judge), log: (l) => logs.push(l) });
		const merges = JSON.parse(fs.readFileSync(path.join(buildDir, "merges.json"), "utf-8")) as TopicMerges;
		assert.equal(merges.decisions["climate-and-climate-change|climate-change"]?.same, false);
		assert.equal(s.merged, 0);
		assert.ok(logs.some((l) => /already decided/.test(l)));
	});

	it("leaves undecided a canonical already coined by another decision (same reply)", async () => {
		writeBatch({
			degree: "me",
			course: "Heat",
			topics: [bt("Conduction Heat Flow"), bt("Heat Flow by Conduction")],
		});
		writeBatch({
			degree: "physics",
			course: "Thermal",
			topics: [bt("Radiation Heat Exchange"), bt("Heat Exchange, Radiation")],
		});
		const { store, state } = memStore();
		const logs: string[] = [];
		const s = await dedupeWorld({
			...common(),
			store,
			ask: fakeAsk(() => ({ same: true, canonical: "Heat Transfer" })),
			log: (l) => logs.push(l),
		});
		assert.equal(s.merged, 1);
		const merges = JSON.parse(fs.readFileSync(path.join(buildDir, "merges.json"), "utf-8")) as TopicMerges;
		assert.equal(Object.keys(merges.decisions).length, 1);
		assert.equal(state.world?.topics.length, 3, "only one pair folded; the other pair is not absorbed");
		assert.ok(logs.some((l) => /unrelated merge/.test(l)));
		// the same holds across calls and reruns: the claim comes from merges.json
		const more: string[] = [];
		const again = await dedupeWorld({
			...common(),
			store,
			ask: fakeAsk(() => ({ same: true, canonical: "Heat Transfer" }), more),
			log: () => {},
		});
		assert.equal(again.merged, 0);
		assert.equal(state.world?.topics.length, 3);
	});

	it("stops after 3 failed calls in a row, keeping what it had", async () => {
		seedBatches();
		writeBatch({ degree: "me", course: "Heat", topics: [bt("Heat Transfer"), bt("Heat Transfers")] });
		const { store } = memStore();
		let calls = 0;
		const logs: string[] = [];
		const ask = (async () => {
			calls++;
			throw new Error("plan limit");
		}) as unknown as typeof runClaudeJson;
		await dedupeWorld({ ...common(), store, ask, log: (l) => logs.push(l), batchSize: 1 });
		assert.equal(calls, 6, "3 failed calls, each tried twice; the 4th group is never asked");
		assert.ok(logs.some((l) => /Stopped early/.test(l)));
		assert.equal(fs.existsSync(path.join(buildDir, "merges.json")), false);
	});

	it("retries a failed call once and carries on when the retry works", async () => {
		seedBatches();
		writeBatch({ degree: "me", course: "Heat", topics: [bt("Heat Transfer"), bt("Heat Transfers")] });
		const { store } = memStore();
		let calls = 0;
		const inner = fakeAsk(sameIfBiotechOrBjt);
		const ask = (async (o: unknown) => {
			calls++;
			if (calls === 1) throw new Error("transient");
			return inner(o as never);
		}) as unknown as typeof runClaudeJson;
		const s = await dedupeWorld({ ...common(), store, ask, log: () => {}, batchSize: 1 });
		assert.equal(calls, 5, "4 groups + 1 retry");
		assert.equal(s.newlyDecided, 4);
	});

	it("refuses on a corrupt merges.json instead of treating it as empty", async () => {
		seedBatches();
		fs.writeFileSync(path.join(buildDir, "merges.json"), "{ not json");
		const { store, state } = memStore();
		let asked = 0;
		const ask = (async () => {
			asked++;
			return { decisions: [] };
		}) as unknown as typeof runClaudeJson;
		await assert.rejects(dedupeWorld({ ...common(), store, ask, log: () => {} }), /merges\.json is not valid JSON/);
		assert.equal(asked, 0);
		assert.equal(state.writes, 0);
		assert.equal(fs.readFileSync(path.join(buildDir, "merges.json"), "utf-8"), "{ not json");
	});

	it("rejects a canonical name that is another existing topic", async () => {
		seedBatches();
		const { store } = memStore();
		const s = await dedupeWorld({
			...common(),
			store,
			ask: fakeAsk((names) => (names.some((n) => /transistor/i.test(n)) ? { same: true, canonical: "Diodes" } : { same: false })),
			log: () => {},
		});
		assert.equal(s.merged, 0);
		const merges = JSON.parse(fs.readFileSync(path.join(buildDir, "merges.json"), "utf-8")) as TopicMerges;
		assert.equal(merges.decisions["bipolar-junction-transistor|bipolar-junction-transistors"], undefined);
	});

	it("batches the groups: batchSize 1 makes one call per group", async () => {
		seedBatches();
		const { store } = memStore();
		const prompts: string[] = [];
		await dedupeWorld({ ...common(), store, ask: fakeAsk(sameIfBiotechOrBjt, prompts), log: () => {}, batchSize: 1 });
		assert.equal(prompts.length, 3);
	});

	it("--dry-run asks but writes nothing", async () => {
		seedBatches();
		const { store, state } = memStore(null, [{ nodeId: "n1", topicId: "bipolar-junction-transistors", placedAt: "x" }]);
		const prompts: string[] = [];
		const s = await dedupeWorld({ ...common(), store, ask: fakeAsk(sameIfBiotechOrBjt, prompts), log: () => {}, dryRun: true });
		assert.equal(prompts.length, 1);
		assert.equal(s.merged, 2);
		assert.equal(fs.existsSync(path.join(buildDir, "merges.json")), false);
		assert.equal(fs.existsSync(path.join(buildDir, "merges.md")), false);
		assert.equal(state.world, null);
		assert.equal(state.placements.length, 1);
	});

	it("--no-ask applies existing decisions and makes no model call", async () => {
		seedBatches();
		fs.writeFileSync(
			path.join(buildDir, "merges.json"),
			JSON.stringify({
				version: 1,
				decisions: {
					"bipolar-junction-transistor|bipolar-junction-transistors": decision(true, "Bipolar Junction Transistor"),
				},
			}),
		);
		const { store, state } = memStore();
		let asked = 0;
		const ask = (async () => {
			asked++;
			return { decisions: [] };
		}) as unknown as typeof runClaudeJson;
		const s = await dedupeWorld({ ...common(), store, ask, log: () => {}, noAsk: true });
		assert.equal(asked, 0);
		assert.equal(s.topicsBefore - s.topicsAfter, 1);
		assert.equal(state.world?.topics.some((t) => t.id === "bipolar-junction-transistors"), false);
	});

	it("refuses when a topic to merge away already has a position, unless forced", async () => {
		seedBatches();
		const positioned: WorldFile = {
			version: 1,
			generatedAt: "t",
			degrees: [],
			anchors: { ee: { x: 1, y: 2 } },
			topics: [
				{ ...topic("Bipolar Junction Transistors", ["Electronics"], { degrees: ["ee"] }), position: { x: 5, y: 6 } },
				{ ...topic("Bipolar Junction Transistor", ["Solid State"], { degrees: ["physics"] }), position: { x: 7, y: 8 } },
			],
		};
		const { store, state } = memStore(positioned);
		await assert.rejects(
			dedupeWorld({ ...common(), store, ask: fakeAsk(sameIfBiotechOrBjt), log: () => {} }),
			/position.*--force/s,
		);
		await assert.rejects(
			dedupeWorld({ ...common(), store, ask: fakeAsk(sameIfBiotechOrBjt), log: () => {} }),
			/Caused by 1 group\(s\): bipolar-junction-transistor\|bipolar-junction-transistors/,
		);
		assert.equal(state.writes, 0);
		assert.equal(fs.existsSync(path.join(buildDir, "merges.json")), false);

		const s = await dedupeWorld({ ...common(), store, ask: fakeAsk(sameIfBiotechOrBjt), log: () => {}, force: true });
		assert.equal(s.merged, 2);
		const kept = state.world?.topics.find((t) => t.id === "bipolar-junction-transistor");
		assert.deepEqual(kept?.position, { x: 7, y: 8 });
		assert.deepEqual(state.world?.anchors, { ee: { x: 1, y: 2 } });
	});

	it("keeps progress when the model fails part-way", async () => {
		seedBatches();
		const { store } = memStore();
		let calls = 0;
		const ask = (async (o: { prompt: string }) => {
			calls++;
			if (calls > 1) throw new Error("plan limit");
			return fakeAsk(sameIfBiotechOrBjt)(o as never);
		}) as unknown as typeof runClaudeJson;
		await dedupeWorld({ ...common(), store, ask, log: () => {}, batchSize: 1 });
		const merges = JSON.parse(fs.readFileSync(path.join(buildDir, "merges.json"), "utf-8")) as TopicMerges;
		assert.equal(Object.keys(merges.decisions).length, 1);
	});
});

describe("readMerges / buildWorld (the generate path)", () => {
	const mergesFile = (): string => path.join(buildDir, "merges.json");

	it("reads a missing file as empty, but refuses a present file that is unreadable as a merge list", () => {
		assert.deepEqual(readMerges(mergesFile()), { version: 1, decisions: {} });
		fs.writeFileSync(mergesFile(), "oops");
		assert.throws(() => readMerges(mergesFile()), /not valid JSON/);
		fs.writeFileSync(mergesFile(), JSON.stringify({ version: 2, decisions: {} }));
		assert.throws(() => readMerges(mergesFile()), /not a valid merge list/);
		fs.writeFileSync(mergesFile(), JSON.stringify({ version: 1, decisions: { "a|b": { same: "yes" } } }));
		assert.throws(() => readMerges(mergesFile()), /not a valid merge list/);
	});

	it("applies merges.json and carries positions and anchors; a corrupt file is a hard error", () => {
		seedBatches();
		fs.writeFileSync(
			mergesFile(),
			JSON.stringify({
				version: 1,
				decisions: {
					"bipolar-junction-transistor|bipolar-junction-transistors": decision(true, "Bipolar Junction Transistor"),
				},
			}),
		);
		const prev: WorldFile = {
			version: 1,
			generatedAt: "t",
			degrees: [],
			anchors: { ee: { x: 1, y: 2 } },
			topics: [{ ...topic("Diodes", ["Electronics"], { degrees: ["ee"] }), position: { x: 3, y: 4 } }],
		};
		const { store, state } = memStore(prev);
		const reportFile = path.join(buildDir, "WORLD.md");
		const plan = buildWorld({ buildDir, mergesFile: mergesFile(), reportFile, store, now: () => "now" });
		const ids = (state.world?.topics ?? []).map((t) => t.id);
		assert.equal(ids.includes("bipolar-junction-transistors"), false);
		assert.equal(ids.includes("bipolar-junction-transistor"), true);
		assert.deepEqual(state.world?.topics.find((t) => t.id === "diodes")?.position, { x: 3, y: 4 });
		assert.deepEqual(state.world?.anchors, { ee: { x: 1, y: 2 } });
		assert.equal(state.world?.generatedAt, "now");
		assert.equal(plan.aliases.get("bipolar-junction-transistors"), "bipolar-junction-transistor");
		assert.match(fs.readFileSync(reportFile, "utf-8"), /# World/);

		fs.writeFileSync(mergesFile(), "{");
		const writes = state.writes;
		assert.throws(() => buildWorld({ buildDir, mergesFile: mergesFile(), reportFile, store }), /not valid JSON/);
		assert.equal(state.writes, writes);
	});
});
