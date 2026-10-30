# Forest plan 1: the fork and the world. Implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A running LearnHarness fork on Isaac's Windows machine and Claude plan, with a generated, laid-out world of every 4-year BS STEM topic, and every graph proposition placed into a world topic.

**Architecture:**
- A GitHub fork of LearnHarness 0.4.0.
- New pure-core modules for world data, placement and layout (`src/core/world*.ts`), plus one new fs store, `src/store/world.ts`, owned by the new Cartographer system.
- World generation and layout are one-time `tsx` scripts that drive the `claude` CLI directly.
- Placement is a new background role, `placer`, run on LearnHarness's `runSubmitAgent` seam after every extraction run.

**Tech Stack:** TypeScript, Next.js (LearnHarness's version), `node:test` via `tsx --test`, TypeBox schemas, d3-force, the Claude Code CLI.

**Spec:** `docs/superpowers/specs/2026-10-30-learnharness-fork-design.md`. Both files move into the fork in Task 1.

**This is plan 1 of 4.** The spec covers four subsystems that each ship working software. They are planned one at a time, after the previous one runs:
1. **This plan:** the fork and the world (spec §3, §5, §9 "Running it").
2. The forest view (spec §6).
3. Levelling: the grader role, Haiku grading, practice verdicts, toss-ups and the Scorekeeper (spec §7, §8 grading).
4. Context: app context, the profiler, `world_lookup`, and turning on graph tools (spec §8 context).

## Global Constraints

- LearnHarness ≥ 0.4.0, using its Claude Code CLI provider.
- Every model call goes through the Claude Code CLI signed in with Isaac's plan. `ANTHROPIC_API_KEY` must never reach a `claude` child process.
- Windows 11. Never ask Isaac to run an executable the builder compiled: no `electron-builder`, no `desktop:dist`. Node scripts and Anthropic's `claude.exe` are fine.
- Keep LearnHarness's AGPL-3.0 `LICENSE` file.
- Keep upstream mergeable: new work goes in new files. Edits to existing upstream files are limited to the ones each task names.
- LearnHarness's architecture laws hold: the import law (`npm run lint`), one writing system per store, and append-only evidence with everything else derived.
- The data folder lives outside the repo, set by `LH_DATA_DIR`. Tests always use the repo's `data/`, never Isaac's data folder.
- Commits are authored as Isaac Levesque <isaac.a.levesque@gmail.com>.
- World degrees, as a config array: mathematics, physics, electrical engineering, computer science, chemistry, mechanical engineering, biology, earth & space science.
- Topic grain: about one lecture-week of a standard course.
- A topic's position never changes once saved.

## Review Focus

1. **Isaac has `ANTHROPIC_API_KEY` set in his Windows environment.** Lessons, placement and world generation must still bill his plan, not API credits. Tests are in Task 1 and Task 4.
2. **Tests running in a shell where `LH_DATA_DIR` points at Isaac's real data.** `npm test` must not read or write it. Test in Task 1.
3. **World generation stopped halfway** (plan limit hit, laptop closed, malformed model reply). A rerun resumes without redoing finished courses, and a bad reply never reaches `topics.json`. Tests in Task 4.
4. **The same topic named differently across degrees** ("Linear Algebra" and "linear algebra", or "Thermodynamics" in physics, chemistry and MechE). It ends up as one topic listing every degree. Test in Task 2.
5. **The placer model returns a topic it wasn't offered, skips a node, or a node is deleted after placement.** The bad submission is retried, and deleted nodes' placements are ignored. Tests in Task 2 and Task 5.

---

### Task 1: Fork, run on Windows on the Claude plan, launcher

**Files:**
- Modify: `package.json` (the `test` script, plus new scripts named below)
- Modify: `src/agent/claude-code/stream.ts:613-617` (`toClaudeEnv`)
- Create: `scripts/launch.mjs` and `scripts/launch-hidden.vbs` (adapted from AI Tutor's files of the same names)
- Create: `scripts/install-app.mjs` (adapted from AI Tutor's)
- Create: `docs/forest/` with the spec, this plan, and `docs/forest/handoff-learn-skill.md` (copied from AI Tutor's `docs/`)
- Test: `tests/claude-code-env.test.ts`, `tests/test-data-dir.test.ts`

**Interfaces:**
- Produces: `toClaudeEnv()` in `stream.ts` never contains `ANTHROPIC_API_KEY`. Export it for the test.

- [ ] **Step 1: Fork and clone.** Fork https://github.com/amosblomqvist/learnharness into Isaac's GitHub account (`gh repo fork amosblomqvist/learnharness --clone`) into `C:\Users\isaac\Documents\learnharness-forest`, then `git remote -v` and confirm that `upstream` exists. Set `git config user.name "Isaac Levesque"` and `git config user.email isaac.a.levesque@gmail.com` in the repo.
- [ ] **Step 2: Make the test script Windows-safe and data-safe.** Add `cross-env` as a devDependency. Change `test` to `cross-env NODE_ENV=test LH_DATA_DIR= tsx --test tests/*.test.ts tests/*.test.tsx`. An empty `LH_DATA_DIR` is falsy in `config.ts`, so tests resolve to the repo's `data/`.
- [ ] **Step 3: Write the failing tests.**

```ts
// tests/test-data-dir.test.ts
it("tests never resolve Isaac's LH_DATA_DIR", async () => {
  const { PATHS, ROOT } = await import("../config.ts");
  assert.equal(PATHS.data, path.join(ROOT, "data"));
});

// tests/claude-code-env.test.ts
it("strips ANTHROPIC_API_KEY from the claude child env", () => {
  process.env.ANTHROPIC_API_KEY = "sk-test";
  try { assert.equal(toClaudeEnv().ANTHROPIC_API_KEY, undefined); }
  finally { delete process.env.ANTHROPIC_API_KEY; }
});
```

- [ ] **Step 4: Run them.** `npm test -- --test-name-pattern="LH_DATA_DIR|ANTHROPIC"`. Expected: the env test FAILS, and the data-dir test PASSES (it pins Step 2).
- [ ] **Step 5: Implement.** Export `toClaudeEnv` and delete `ANTHROPIC_API_KEY` from its result. Add a one-line comment saying this fork bills the signed-in plan, never the API.
- [ ] **Step 6: Verify the whole suite.** Run `npm test`, `npm run lint` and `npm run typecheck`. Expected: all pass. Report any upstream test that fails on Windows before this change. Fix only the ones caused by bash-only syntax.
- [ ] **Step 7: Launcher.** Copy AI Tutor's `scripts/launch.mjs`, `scripts/launch-hidden.vbs` and `scripts/install-app.mjs` from `C:\Users\isaac\Documents\AITutor\scripts\` and adapt them:
  - start `npm run dev` with `LH_DATA_DIR=C:\Users\isaac\Documents\learnharness-data`;
  - open `http://localhost:3000` in an Edge app window;
  - name the shortcut "Forest".

  Add `"app": "node scripts/launch.mjs"` and `"install-app": "node scripts/install-app.mjs"` to `package.json`.
- [ ] **Step 8: Manual check with Isaac.**
  1. Run `npm run install-app` and open "Forest".
  2. In Settings → Providers, connect Claude Code. Set the strong slot to Opus and the cheap slot to Sonnet.
  3. Run one short lesson and one practice session.

  Expected: both work, and `C:\Users\isaac\Documents\learnharness-data\chats\` holds the session files. Ask Isaac to confirm that the usage shows on his Claude plan.
- [ ] **Step 9: Commit.** Add `docs/forest/*`, `package.json`, `package-lock.json`, `stream.ts`, the new tests and the scripts, with the message `forest: fork setup, Windows test script, plan-only CLI env, launcher`.

---

### Task 2: World contracts and pure world logic

**Files:**
- Create: `src/core/contracts/world.ts`
- Create: `src/core/world.ts`
- Test: `tests/world.test.ts`

**Interfaces:**
- Produces (contracts):

```ts
export interface WorldDegree { id: string; name: string }
export interface WorldPosition { x: number; y: number }
export interface WorldTopic {
  id: string; name: string; scope: string;
  degrees: string[]; courses: string[]; prereqs: string[];
  position?: WorldPosition;
}
export interface WorldFile { version: 1; generatedAt: string; degrees: WorldDegree[]; topics: WorldTopic[] }
export interface CourseTopicsBatch {
  degree: string; course: string;
  topics: Array<{ name: string; scope: string; prereqs: string[] }>;
}
export interface Placement { nodeId: string; topicId: string | null; placedAt: string }
```

- Produces (functions in `src/core/world.ts`):
  - `topicSlug(name: string): string`
  - `mergeDegreeTopics(batches: CourseTopicsBatch[]): { topics: WorldTopic[]; unresolvedPrereqs: Array<{ topic: string; prereq: string }> }`
  - `isWorldFile(v: unknown): v is WorldFile`
  - `isCourseTopicsBatch(v: unknown): v is CourseTopicsBatch`
  - `mergePlacements(lines: Placement[], liveNodeIds: ReadonlySet<string>): Map<string, string | null>`
  - `unplacedNodeIds(nodeIds: string[], merged: Map<string, string | null>): string[]`
  - `topicCandidates(text: string, topics: WorldTopic[], k: number): WorldTopic[]`

- [ ] **Step 1: Write the failing tests** in `tests/world.test.ts`:
  - `topicSlug("Linear Algebra ")` returns `"linear-algebra"`, and `topicSlug("Fourier analysis & PDEs")` returns `"fourier-analysis-pdes"`.
  - `mergeDegreeTopics` with "Linear Algebra" (math, course "Linear Algebra I") and "linear algebra" (physics, course "Mathematical Methods") returns one topic, `id "linear-algebra"`, with `degrees` `["math","physics"]` and both courses.
  - Prereq names resolve to ids through `topicSlug`. A prereq naming no generated topic is dropped from `prereqs` and listed in `unresolvedPrereqs`. A topic never lists itself as a prereq.
  - The output is sorted by `id`, and degrees and courses are sorted and deduplicated, so a rerun produces identical JSON.
  - `isCourseTopicsBatch` rejects a missing `topics` array, a topic without a string `scope`, and non-array `prereqs`.
  - `mergePlacements`: for two lines for the same node, the later `placedAt` wins. A line whose node isn't in `liveNodeIds` is ignored. `topicId: null` is kept as `null`.
  - `unplacedNodeIds(["a","b","c"], new Map([["a","t1"],["b",null]]))` returns `["c"]`. A node placed as `null` counts as placed.
  - `topicCandidates("Gauss quadrature exactness degree 2n-1", topics, 2)` ranks a topic named "Gaussian quadrature" with scope "…exact for polynomials…" first. It returns at most `k` topics and never returns topics with zero overlap.
- [ ] **Step 2: Run them.** `npm test -- --test-name-pattern=world`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement the contracts and `src/core/world.ts`.**
  - `topicSlug`: lowercase, drop `&` and any other non-alphanumerics, collapse to single hyphens, trim hyphens.
  - `topicCandidates`: score by overlap of lowercased word stems of 4+ letters (strip a trailing `s`) between `text` and `name + " " + scope`, with name hits weighted ×2. Break ties by `id`.
  - No imports outside `src/core`.
- [ ] **Step 4: Run the tests.** `npm test -- --test-name-pattern=world`. Expected: PASS. Then run `npm run lint`: PASS.
- [ ] **Step 5: Commit.** Message: `forest: world contracts and pure world logic`.

---

### Task 3: World layout (positions that never move)

**Files:**
- Create: `src/core/world-layout.ts`
- Test: `tests/world-layout.test.ts`

**Interfaces:**
- Consumes: `WorldTopic` and `WorldDegree` from Task 2.
- Produces:
  - `WORLD_DEGREES: readonly WorldDegree[]`, the 8 degrees: `{id:"math",name:"Mathematics"}`, `physics`/"Physics", `ee`/"Electrical Engineering", `cs`/"Computer Science", `chemistry`/"Chemistry", `me`/"Mechanical Engineering", `biology`/"Biology", `earth-space`/"Earth & Space Science".
  - `DEGREE_ANCHORS: Readonly<Record<string, WorldPosition>>`.
  - `layoutWorld(topics: WorldTopic[], seed: number): WorldTopic[]`. It returns the same topics, each with a `position`, and never changes a position that was already set.

- [ ] **Step 1: Write the failing tests:**
  - **Every topic gets a finite position.**
  - **The layout is deterministic.** `layoutWorld(t, 7)` called twice gives deep-equal output.
  - **Existing positions stay put.** Lay out 30 topics, then add 5 new ones and lay out again. The original 30 keep identical positions, and the 5 new ones get positions.
  - **Degrees sit where their anchors say.** The mean position of math-only topics is nearer `DEGREE_ANCHORS.math` than any other anchor.
  - **Shared topics sit between their degrees.** A topic with `degrees: ["math","physics"]` is closer to the midpoint of those two anchors than to either anchor alone.
  - **Prerequisites stay close.** Over a fixture with prerequisite links, the mean distance between a topic and its prereqs is smaller than the mean distance between random pairs.
- [ ] **Step 2: Run them.** `npm test -- --test-name-pattern=layout`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Anchors, in world units (from the approved mockup, ×100):

    | Degree | Anchor |
    |---|---|
    | earth-space | (14000, 11000) |
    | math | (32000, 27000) |
    | physics | (54000, 16000) |
    | chemistry | (80000, 9000) |
    | biology | (92000, 26000) |
    | ee | (76000, 30000) |
    | cs | (64000, 47000) |
    | me | (17000, 44000) |

  - Degree ids are `math`, `physics`, `ee`, `cs`, `chemistry`, `me`, `biology`, `earth-space`.
  - Each topic's anchor is the mean of its degrees' anchors.
  - d3-force simulation:
    - `forceX`/`forceY` toward the anchor at strength 0.08;
    - `forceLink` over prereqs, distance 600, strength 0.3;
    - `forceCollide` radius 180;
    - `forceManyBody` strength −30;
    - `randomSource` from a seeded LCG;
    - initial positions jittered around the anchor by a hash of the id.
  - Topics that already have a position get `fx`/`fy` pinned.
  - Run 600 ticks synchronously with `simulation.stop()` and `tick(600)`.
- [ ] **Step 4: Run the tests.** Expected: PASS, and lint passes.
- [ ] **Step 5: Commit.** Message: `forest: deterministic world layout with fixed positions`.

---

### Task 4: World store and the generation and layout scripts

**Files:**
- Modify: `config.ts` (add `WORLD_FILES`)
- Modify: `src/core/ports.ts` (add `WorldStore`)
- Modify: `src/server/stores.ts` (wire `worldStore`)
- Create: `src/store/world.ts`
- Create: `scripts/world/claude-cli.ts`, `scripts/world/generate.ts`, `scripts/world/layout.ts`
- Create: `scripts/world/prompts/courses.md`, `scripts/world/prompts/topics.md`
- Modify: `package.json` (add `world:generate` and `world:layout`)
- Test: `tests/world-store.test.ts`, `tests/world-generate.test.ts`

**Interfaces:**
- Consumes: everything from Task 2, plus `layoutWorld` from Task 3.
- Produces:

```ts
// config.ts
export const WORLD_FILES = {
  dir: path.join(DATA_ROOT, "world"),
  topics: path.join(DATA_ROOT, "world", "topics.json"),
  report: path.join(DATA_ROOT, "world", "WORLD.md"),
  build: path.join(DATA_ROOT, "world", "build"),          // <degree>/<course-slug>.json
  placements: path.join(DATA_ROOT, "world", "placements.jsonl"),
} as const;

// core/ports.ts
export interface WorldStore {
  readWorld(): WorldFile | null;              // null when topics.json is absent or invalid
  writeWorld(world: WorldFile): void;          // atomic: temp file + rename
  appendPlacement(p: Placement): void;
  readPlacements(): Placement[];               // corrupt lines skipped
}

// scripts/world/claude-cli.ts
export function claudeEnv(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;   // drops ANTHROPIC_API_KEY
export function runClaudeJson<T>(o: { model: "opus" | "sonnet"; systemPrompt: string; prompt: string; schema: object }): Promise<T>;

// scripts/world/generate.ts
export async function generateWorld(o: { degrees: WorldDegree[]; buildDir: string; ask: typeof runClaudeJson; log: (s: string) => void }): Promise<CourseTopicsBatch[]>;
```

- [ ] **Step 1: Write the failing tests.**
  - **`tests/world-store.test.ts`** uses the repo `data/` and snapshots and restores `data/world/` the way `tests/settings-store.test.ts` does.
    - **Round trip:** `writeWorld` then `readWorld`.
    - **Bad `topics.json`:** an invalid file reads as `null`.
    - **Placements:** `appendPlacement` ×2 then `readPlacements` returns both, in order, and a corrupt line between them is skipped.
  - **`tests/world-generate.test.ts`** uses a fake `ask` and a temp `buildDir`.
    - **Normal run:**
      - The courses call returns `{courses:["A","B"]}`, then one topics call per course.
      - Each batch is written to `buildDir/<degree>/<course-slug>.json`.
      - The returned batches equal what was written.
    - **Resume:** with `buildDir/math/a.json` already present, a second run makes no topics call for course A (count the `ask` calls).
    - **Bad replies:**
      - A topics reply that fails `isCourseTopicsBatch` is retried once, then skipped and logged. No file is written for it.
      - The other courses still complete.
    - **API key:** `claudeEnv({ ANTHROPIC_API_KEY: "x", PATH: "p" })` returns `{ PATH: "p" }`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement the store** (`src/store/world.ts`) in the idioms of `src/store/graph.ts`: sync fs, strict reads, `mkdirSync` on write. Wire `worldStore` into `stores` in `src/server/stores.ts`.
- [ ] **Step 4: Implement `claude-cli.ts`.** Spawn `claude -p --output-format json --json-schema <schema> --model <model> --system-prompt-file <tmp> --safe-mode --tools "" --no-session-persistence` with `env: claudeEnv()`, feed the prompt on stdin, and parse `structured_output` from the JSON result. Model the spawn and Windows lookup on `src/agent/claude-code/binary.ts`. AI Tutor's old `lib/claude.ts` used the same flags.
- [ ] **Step 5: Write the prompts.**
  - **`courses.md`:** for one degree, list the required and common elective courses of a typical ABET-accredited (or equivalent) 4-year BS. Use course names, not codes.
  - **`topics.md`:** for one course, list its topics at the grain of about one lecture-week. Each topic gets:
    - `name`, written as a general concept, never applied to a project;
    - a one-line `scope`;
    - `prereqs`, named as topics from any undergrad STEM course.
- [ ] **Step 6: Implement `generateWorld` and the CLI entries.**
  - **`scripts/world/generate.ts`** runs `generateWorld` for `WORLD_DEGREES` with Opus, one call at a time. It then writes `topics.json` through `worldStore.writeWorld` (via `mergeDegreeTopics`, positions empty), so the Cartographer store stays the only writer. It also writes `WORLD.md`, which holds:
    - the degree and topic counts;
    - each degree's courses with topic counts;
    - the unresolved prereqs.
  - **`scripts/world/layout.ts`** reads the world with `worldStore.readWorld()`, runs `layoutWorld(topics, 7)` and writes it back with `writeWorld`.
  - **`package.json`:**

    ```
    "world:generate": "tsx scripts/world/generate.ts"
    "world:layout": "tsx scripts/world/layout.ts"
    ```

    Both read `LH_DATA_DIR`.
- [ ] **Step 7: Run the tests.** `npm test`, then lint and typecheck. Expected: PASS.
- [ ] **Step 8: Real run, with Isaac's go-ahead (it uses his plan).**
  1. Run `npm run world:generate` with `LH_DATA_DIR` set to his data folder. Stop after the math degree and show Isaac `WORLD.md` for a grain check.
  2. On his go-ahead, rerun for the rest. It resumes.
  3. Run `npm run world:layout`.

  Expected: `topics.json` holds thousands of topics, all with positions.
- [ ] **Step 9: Commit.** Commit the code, prompts and tests only, never `data/`. Message: `forest: world store, generation and layout scripts`.

---

### Task 5: The placer role and stage

**Files:**
- Modify: `config.ts` (`ModelRole` gains `"placer"`)
- Modify: `src/core/settings.ts` (`ROLE_SLOT.placer = "cheap"`; `"placer"` appended to `BACKGROUND_MODEL_ROLES`)
- Modify: `src/server/settings-body.ts` (comment count only, if it names the number of roles)
- Modify: `tests/settings.test.ts:207-…` (expected role list gains `"placer"`)
- Create: `src/agent/subagents/placer.ts`
- Modify: `src/server/chat-handler.ts:119` (wrap `extraction`)
- Modify: `src/agent/subagents/extraction.ts` (`EXTRACTION_CORE`, one sentence)
- Modify: `src/agent/prompts/teacher/20-teaching.md` (one sentence)
- Test: `tests/placer.test.ts`

**Interfaces:**
- Consumes: `WorldStore` (Task 4); `mergePlacements`, `unplacedNodeIds` and `topicCandidates` (Task 2); `getGraph` (`src/core/graph.ts`); `runSubmitAgent` (`src/agent/subagents/submit-agent.ts`); `withBgLlmSlot` (`bg-llm-semaphore.ts`).
- Produces:

```ts
export interface PlacerDeps {
  graphStore: Pick<GraphStore, "readNodes" | "readChains">;
  worldStore: WorldStore;
  engineFor: (role: ModelRole) => PiEngine | undefined;
  now?: () => string;
}
export interface PlacementStats { placed: number; uncharted: number; skipped: number }
export function createPlacer(deps: PlacerDeps): { placeUnplaced(signal?: AbortSignal): Promise<PlacementStats> };
export function withPlacement(pipeline: ExtractionPipeline, placer: ReturnType<typeof createPlacer>): ExtractionPipeline;
```

- [ ] **Step 1: Write the failing tests** in `tests/placer.test.ts`, using a faux engine (the `fauxEngine` pattern in `tests/extraction.test.ts`), an in-memory graph store and an in-memory `WorldStore`.
  - **It places what's unplaced:**
    - With 3 unplaced nodes and the faux model submitting a valid topic for 2 and `null` for 1, it appends 3 placements and returns `{placed:2, uncharted:1, skipped:0}`.
    - A second call makes no model call.
  - **A topic outside the offered candidates is rejected.**
    - The first submit names one; the validate step rejects it and the faux model resubmits a valid choice.
    - Exactly one placement is written per node.
  - **An omitted node is rejected.** A submit that leaves out a batch node is rejected the same way.
  - **Batching:** 45 unplaced nodes produce 3 submit calls of at most 20 nodes each.
  - **No world yet:** with no world (`readWorld()` returns `null`), it returns `{placed:0, uncharted:0, skipped:<count>}` and makes no model call.
  - **No model configured:** with no engine configured (`engineFor` returns `undefined`), it resolves the same as having no world and makes no model call.
  - **`withPlacement`:** after `runExtraction` resolves, `placeUnplaced` is called once. If `runExtraction` rejects, it isn't called, and the rejection still propagates.
- [ ] **Step 2: Run them.** `npm test -- --test-name-pattern=placer`. Expected: FAIL.
- [ ] **Step 3: Add the role.** Change `ModelRole`, `ROLE_SLOT` and `BACKGROUND_MODEL_ROLES`, and update the expected list in `tests/settings.test.ts`. Run `npm test -- --test-name-pattern="settings|model-catalog"`: PASS.
- [ ] **Step 4: Implement `placer.ts`.**
  - **Candidates:** for each batch of 20 unplaced nodes (sorted by id), build each node's candidates with `topicCandidates(name + " " + statement, topics, 25)`. A node with no candidates is placed `null` without a model call.
  - **The model call:** one `runSubmitAgent` per batch, run inside `withBgLlmSlot`:
    - `role: "placer"`, `toolName: "submit_placements"`;
    - schema: `{ placements: Array<{ nodeId: string; topicId: string | null }> }`;
    - `validate`: the nodeIds must equal the batch exactly, with each `topicId` in that node's candidate ids or `null`.
  - **The system prompt:** place each general proposition in the single undergrad topic where it is taught, or `null` if none fits.
  - **Writing:** append one `Placement` per node with `placedAt: now()`.
- [ ] **Step 5: Wire it.** In `chat-handler.ts`, change `export const extraction = createExtractionPipeline({...})` to `export const extraction = withPlacement(createExtractionPipeline({...}), createPlacer({ ...stores, engineFor: (role) => resolveEngine(role) }))`. `withPlacement` wraps `runExtraction` and `importNotes` with `.then(stats => { void placer.placeUnplaced().catch(log); return stats; })`.
- [ ] **Step 6: State propositions in general form (spec decision 6).**
  - Add one test to `tests/placer.test.ts`: `EXTRACTION_CORE` (exported from `extraction.ts`) contains the sentence `State every proposition in general form, independent of any project or application it was taught for.`
  - Add that exact sentence to `EXTRACTION_CORE` in `src/agent/subagents/extraction.ts`.
  - Add the same sentence to `src/agent/prompts/teacher/20-teaching.md`, at the end of the "Teach — one step at a time" list.
  - Run `npm test -- --test-name-pattern="placer|extraction"`. Expected: PASS.
- [ ] **Step 7: Run everything.** `npm test`, `npm run lint` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 8: Manual check.**
  1. Set the placer role to Sonnet in Settings → Agent.
  2. Run a short lesson until extraction runs.

  Expected: `learnharness-data/world/placements.jsonl` gains one line per new proposition, and the topic choices look right to Isaac.
- [ ] **Step 9: Commit.** Message: `forest: placer role places every proposition into a world topic`.
