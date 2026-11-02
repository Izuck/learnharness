# Forest 2: the forest view, implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A fog-of-war forest of the whole world, which becomes the home page. Continuous zoom goes from world, to degree region, to topic clearing, to the proposition graph. The existing graph canvas stays reachable as "Graph".

**Architecture:**
- **Model.** A pure core module, `src/core/forest.ts`, folds three things into a `ForestModel`: the world file, the placements ledger, and the live graph. The model holds lit topics, regions, derived trails, uncharted ideas and coverage.
- **Data path.** A server function and `GET /api/forest` ship that model with the proposition data the clearing level needs.
- **Rendering.** A new hand-rolled Canvas 2D renderer, `components/forest-canvas.ts`, draws the forest. It uses the same patterns as `components/graph-canvas.ts`: d3-zoom pan/pinch, a custom eased wheel, an on-demand rAF loop and dpr-aware drawing. It switches level of detail by zoom.
- **Host.** `components/forest-view.tsx` fetches the model, hosts the canvas, and draws the overlays: coverage line, uncharted margin and idea card.

**Tech Stack:** Next.js app router, TypeScript, Canvas 2D, d3-zoom (already a dependency), and node:test via tsx with linkedom for DOM tests.

**Spec:** `docs/forest/2026-10-30-learnharness-fork-design.md`, §6 (forest view), plus §5 (world and placements) and §7 (idea states, for the state type only).

## Global Constraints

- **Import law** (eslint `import/no-restricted-paths`):
  - `components/**` imports only `@/src/core`;
  - `app/**` imports only `@/src/core` and `@/src/server`;
  - `src/core` is pure (no node:, no store, no server).
  - `npm run lint` must pass.
- **Positions never change.** The forest only reads `topics.json` and `placements.jsonl` and never writes them. Trails are derived, never stored. (Spec §2 anti-goal, §6.)
- **Rendering** is hand-rolled Canvas 2D, like `components/graph-canvas.ts`. No new rendering library.
- **Zoom** is continuous scroll zoom with level-of-detail switching, not separate pages. Nothing moves between levels.
- **Copy:**
  - The world-level coverage line is `Mapped <p> of undergrad STEM`, for example "Mapped 0.07% of undergrad STEM".
  - Fogged topic names carry a "?".
- **Look:** dark green trees, warm gold light for learned clearings, dotted trails, and faint italic degree names (the approved fog-of-war mockup).
- **Tests** are deterministic, with no LLM and no network. Run them with `$env:LH_DATA_DIR=''; npx tsx --test <files>` in PowerShell. The full suite runs with `npm test`, which has 18 known Windows/env failures. Then run `npm run typecheck` and `npm run lint`.
- **Commits** are made as Isaac Levesque <isaac.a.levesque@gmail.com>, one per task, and end with the `Co-Authored-By` line the controller gives.
- **Real data is off limits.** Never run `world:generate` or `world:layout` without `--dry-run`, and never write into `C:\Users\isaac\Documents\learnharness-data`.

## Review Focus

1. **No world, or a world not laid out yet.**
   - *Expected:* with no `topics.json`, the forest shows an empty state naming `npm run world:generate`, then `npm run world:layout`, plus a link to Graph. With topics but no positions, it names `world:layout`. It never shows a blank canvas or throws.
   - *Tests:* `buildForest` with unpositioned topics (Task 1) and `ForestView` empty states (Task 4).
2. **Stale or dangling placements.**
   - *Expected:* a placement to a deleted node is ignored. A placement to a topic id that is no longer in the world, or that has no position, counts as uncharted, not lost.
   - *Test:* Task 1.
3. **A full world of about 5,000 topics.**
   - *Expected:* pan and zoom stay smooth. Off-screen topics are culled, and labels are capped per frame, with lit topics first.
   - *Tests:* `visibleTopics` and `pickLabels` (Task 2).
4. **Chains with members outside the forest.**
   - *Expected:* a trail joins two different placed, positioned topics only. Members that are uncharted or unplaced add no trail, and a chain wholly inside one topic adds none.
   - *Test:* Task 1.
5. **A fresh learner, and tiny coverage.**
   - *Expected:* zero placed ideas reads "Mapped 0% of undergrad STEM". 1 of 5,000 topics reads "Mapped 0.02%", never "0.00%".
   - *Test:* `formatCoverage` (Task 1).

---

## File structure

| File | Responsibility |
|---|---|
| `src/core/contracts/forest.ts` (new) | Types: `IdeaState`, `StateCounts`, `ForestTopic`, `ForestRegion`, `ForestTrail`, `ForestModel`, `ForestSnapshot` |
| `src/core/forest.ts` (new) | Pure model and geometry: `buildForest`, `formatCoverage`, `topicGlow`, `forestLevel`, `visibleTopics`, `pickLabels`, `layoutClearing`, constants |
| `src/core/index.ts` (modify) | Export the world and forest contracts, plus `src/core/forest.ts` |
| `src/server/forest.ts` (new), `src/server/index.ts` (modify) | `forestView(): ForestSnapshot` |
| `app/api/forest/route.ts` (new) | `GET` returns `forestView()` |
| `components/forest-canvas.ts` (new) | `ForestCanvasRenderer`, DOM-bound and exercised live |
| `components/forest-view.tsx` (new) | Fetch, refresh, canvas host, coverage line, uncharted margin, idea card, empty states |
| `components/forest-idea-card.tsx` (new) | Statement, chains and sessions of one idea |
| `components/home.tsx`, `app/page.tsx`, `app/graph/page.tsx` (new), `src/core/keyboard.ts`, `components/keyboard-shortcuts.tsx` | Forest at `/`, graph at `/graph`, Forest/Graph switch, shortcuts |
| `app/globals.css` (modify) | Forest colour tokens |

---

### Task 1: The forest model (pure)

**Files:**
- Create: `src/core/contracts/forest.ts`, `src/core/forest.ts`
- Modify: `src/core/index.ts`, which gains `export * from "./contracts/world.ts"`, `export * from "./contracts/forest.ts"` and `export * from "./forest.ts"`. Do not export `world.ts`, `world-layout.ts` or `world-anchors.ts` from the barrel; `forest.ts` imports what it needs from them directly.
- Test: `tests/forest.test.ts`

**Interfaces:**
- Consumes:
  - `WorldFile`, `WorldTopic` and `Placement` (`src/core/contracts/world.ts`);
  - `mergePlacements(lines, liveNodeIds): Map<string, string | null>` (`src/core/world.ts`);
  - `WORLD_DEGREES` (`src/core/world-layout.ts`);
  - `GraphNode` and `GraphChain` (`src/core/contracts/graph.ts`).
- Produces (`src/core/contracts/forest.ts`):
  ```ts
  /** An idea's level-of-knowledge. "fogged" is not a state an idea has — it is
   *  the absence of the idea from the graph. Plan 3 (levelling) supplies the real
   *  states; until then every idea in the graph is "seen". */
  export type IdeaState = "seen" | "held" | "fast";
  export interface StateCounts { seen: number; held: number; fast: number }
  export interface ForestTopic {
    id: string; name: string; scope: string; degrees: string[];
    x: number; y: number;
    ideas: string[];        // node ids placed here, sorted
    counts: StateCounts;
    glow: number;           // 0 = fogged, else (0,1]; see topicGlow
  }
  export interface ForestRegion { degreeId: string; name: string; x: number; y: number }
  export interface ForestTrail { a: string; b: string; chains: number; crossDegree: boolean } // a < b
  export interface ForestModel {
    topics: ForestTopic[];  // positioned topics only, in world order
    regions: ForestRegion[];
    trails: ForestTrail[];  // sorted by (a, b)
    uncharted: string[];    // node ids: placed null, or to a topic missing / unpositioned; sorted
    unplaced: number;       // live nodes with no placement decision yet
    unpositioned: number;   // world topics with no position (layout not run)
    coverage: { mapped: number; total: number }; // topics with ≥1 idea / positioned topics
  }
  export interface ForestSnapshot {
    model: ForestModel | null; // null = no world file
    graph: Pick<GraphSnapshot, "propositions" | "chains" | "sessions" | "fileSources" | "nodeSessions">;
  }
  ```
- Produces (`src/core/forest.ts`):
  - `buildForest(world: WorldFile, placements: readonly Placement[], graph: { propositions: readonly GraphNode[]; chains: readonly GraphChain[] }, stateOf?: (nodeId: string) => IdeaState): ForestModel`
  - `topicGlow(counts: StateCounts): number`
  - `formatCoverage(mapped: number, total: number): string`

- [ ] **Step 1: Write the failing tests** in `tests/forest.test.ts`, with a small fixture world: 4 positioned topics across `math` and `physics`, plus 1 unpositioned topic. Tests:
  - `places ideas on their topic and lights it`: with 2 propositions placed on topic `t1`, `t1.ideas` is the sorted ids, `counts` is `{seen:2,held:0,fast:0}`, and `glow > 0`. An unplaced topic has `glow === 0` and `ideas` `[]`.
  - `stateOf drives counts`: with `stateOf` returning `"fast"` for one id, `counts.fast === 1`.
  - `uncharted collects null, unknown and unpositioned topics`: placements with `topicId: null`, to `"no-such-topic"`, and to the unpositioned topic all land in `uncharted` (sorted).
  - `ignores placements of deleted nodes`: a placement whose node is not in `propositions` changes nothing.
  - `counts undecided live nodes as unplaced`: a live node with no placement line gives `unplaced === 1`.
  - `counts topics without positions`: `unpositioned === 1`, and the unpositioned topic is absent from `topics`.
  - `derives trails between distinct placed topics`: chain `{premises:[n1,n2], conclusion:n3}` with n1→t1, n2→t1, n3→t2 gives exactly one trail `{a:"t1",b:"t2",chains:1,crossDegree:false}` (both topics are math). A second chain between the same topics gives `chains:2`.
  - `marks crossDegree when the topics share no degree`: t1 (math) and t3 (physics) give `crossDegree:true`. A topic in `["math","physics"]` joined to a math topic gives `false`.
  - `no trail from uncharted or unplaced members, nor within one topic`.
  - `regions sit at the centroid of their degree's topics`: the math region's `x`/`y` is the mean of the positioned topics whose `degrees` include `math`. The name comes from `world.degrees`, falling back to `WORLD_DEGREES`. A degree with no positioned topic has no region.
  - `coverage counts topics with at least one idea`: `{mapped:1,total:4}`.
  - `formatCoverage`:
    - `(0,4)` → `"0%"`
    - `(1,5000)` → `"0.02%"`
    - `(7,10000)` → `"0.07%"`
    - `(17,500)` → `"3.4%"`
    - `(1,4)` → `"25%"`
    - `(4,4)` → `"100%"`
    - `(0,0)` → `"0%"`
  - `topicGlow`:
    - no ideas → `0`
    - all seen → `0.475`
    - all fast → `1`
    - monotonic: seen < held < fast for one idea
  - `deterministic`: two `buildForest` calls on the same input are `deepEqual`.

- [ ] **Step 2: Run them to see them fail.** Run `$env:LH_DATA_DIR=''; npx tsx --test tests/forest.test.ts`. Expected: FAIL with module not found.

- [ ] **Step 3: Implement the contracts and `src/core/forest.ts`.** Use `mergePlacements(placements, new Set(propositions.map(n => n.id)))` for the fold. Rules:
  - **`topicGlow`:**
    ```
    total = seen + held + fast; if 0 → 0
    score = (0.3*seen + 0.7*held + 1.0*fast) / total
    glow  = 0.25 + 0.75*score
    ```
  - **`formatCoverage`:**
    ```
    p = 100*mapped/total (0 when total is 0)
    p === 0 → "0%"
    p < 1   → p.toFixed(2), but if that is "0.00" use the
              first non-zero digit (e.g. "0.002%")
    p < 10  → toFixed(1)
    else    → toFixed(0)
    ```
    Strip trailing ".0".

- [ ] **Step 4: Run the tests to see them pass.** Run the same command. Expected: all pass. Then run `npm run typecheck`.

- [ ] **Step 5: Commit** with the message "Forest model: lit topics, regions, derived trails, coverage".

---

### Task 2: Level of detail and clearing geometry (pure)

**Files:**
- Modify: `src/core/forest.ts`
- Test: `tests/forest.test.ts`, by appending a `describe("forest geometry")` block

**Interfaces:**
- Consumes: `ForestTopic` (Task 1), and `incrementalLayout(nodes, edges: LayoutEdge[], previous, options?)` (`src/core/layout.ts`).
- Produces:
  ```ts
  export const REGION_K = 0.12;     // below: world level
  export const CLEARING_K = 1.2;    // at or above: clearing level
  export const CLEARING_R = 160;    // clearing radius, world units (collide radius is 180)
  export const LABEL_BUDGET = 300;  // topic labels drawn per frame at most
  export type ForestLevel = "world" | "region" | "clearing";
  export function forestLevel(k: number): ForestLevel;
  export interface ForestCamera { k: number; x: number; y: number } // screen = world*k + (x,y)
  export function visibleTopics(topics: readonly ForestTopic[], cam: ForestCamera, w: number, h: number, padPx: number): ForestTopic[];
  export function pickLabels(topics: readonly ForestTopic[], budget: number): ForestTopic[];
  export function layoutClearing(ideaIds: readonly string[], chains: readonly GraphChain[], center: { x: number; y: number }, radius: number): Map<string, { x: number; y: number }>;
  ```

- [ ] **Step 1: Write the failing tests:**
  - `forestLevel` thresholds: `0.05` → world, `0.12` → region, `1.19` → region, `1.2` → clearing.
  - `visibleTopics`:
    - Keeps a topic whose screen point is inside the viewport grown by `padPx`, and drops one outside.
    - The camera transform is `screen = world*k + (x,y)`. Test with `{k:0.5,x:100,y:0}`, `w=800`, `h=600`: a topic at world (1300, 0) projects to screen x 750, which is visible.
  - `pickLabels`:
    - With 500 topics and budget 300, it returns 300.
    - Every topic with `glow > 0` comes before every fogged one.
    - Ties are broken by `name` (localeCompare), then `id`.
    - The input array is not mutated.
  - `layoutClearing`:
    - **One idea:** it sits exactly at the center.
    - **Several ideas:** every point lies within `radius` of the center, for 1, 2 and 12 ideas.
    - **Chains:** chain premises→conclusion become edges. A premise and its conclusion end closer together than the mean pairwise distance, with 12 ideas and a chain linking 2 of them.
    - **Deterministic:** two calls give `deepEqual` output.
    - **Unrelated chains:** chains with members outside `ideaIds` are ignored.

- [ ] **Step 2: Run them to see them fail.** Expected: FAIL, because the exports are missing.

- [ ] **Step 3: Implement.** For `layoutClearing`:
  - Build edges from each chain's premises to its conclusion, keeping only edges where both ends are in `ideaIds`.
  - Call `incrementalLayout(ids.map(id => ({ id })), edges, new Map())`.
  - Translate the result's centroid to `center`.
  - Scale uniformly so the farthest point is at `0.85*radius`.

  If the layout depends on input order, sort the ids first.

- [ ] **Step 4: Run the tests to see them pass.** Then run `npm run typecheck`.

- [ ] **Step 5: Commit** with the message "Forest geometry: zoom levels, culling, label budget, clearing layout".

---

### Task 3: Serve the forest

**Files:**
- Create: `src/server/forest.ts`, `app/api/forest/route.ts`
- Modify: `src/server/index.ts` (`export * from "./forest.ts"`)
- Test: `tests/forest-server.test.ts`

**Interfaces:**
- Consumes:
  - `buildForest` (Task 1);
  - `stores.worldStore.readWorld()` and `stores.worldStore.readPlacements()` (`src/server/stores.ts`);
  - `graphView(): GraphSnapshot` (`src/server/graph.ts`).
- Produces:
  - `forestView(): ForestSnapshot`;
  - `GET /api/forest`, which is `export const dynamic = "force-dynamic"` and returns `Response.json(forestView())`.

- [ ] **Step 1: Write the failing test.** Follow the pattern the existing server/store tests use for a temporary `LH_DATA_DIR` (see `tests/world-store.test.ts`). Write a tiny `topics.json` with positions and a `placements.jsonl` into a temp data dir, plus a graph with one proposition through the graph store the same way `tests/graph.test.ts` seeds one. Then check:
  - `forestView().model.coverage` is `{mapped:1,total:N}`;
  - `graph.propositions` has the node.
  - With no `topics.json`, `model` is `null` and `graph` is still filled.

- [ ] **Step 2: Run it to see it fail.**

- [ ] **Step 3: Implement.**
  - `forestView` reads the world. If it is null, return `{ model: null, graph }`. Otherwise call `buildForest(world, readPlacements(), { propositions, chains })` with the default `stateOf`.
  - Take `graph` from `graphView()`, picking `propositions`, `chains`, `sessions`, `fileSources` and `nodeSessions`.
  - Add the route file.

- [ ] **Step 4: Run it to see it pass.** Then run `npm run typecheck` and `npm run lint`.

- [ ] **Step 5: Commit** with the message "Serve the forest model at /api/forest".

---

### Task 4: The forest canvas and view

**Files:**
- Create: `components/forest-canvas.ts`, `components/forest-view.tsx`, `components/forest-idea-card.tsx`
- Modify: `app/globals.css`, adding tokens to both `:root` and `.dark`:
  - `--lh-forest-bg: #0e1511`
  - `--lh-forest-tree: #1d2b22`
  - `--lh-forest-tree-edge: #2a3d30`
  - `--lh-forest-light: #e8b85a`
  - `--lh-forest-trail: #b89a5e`
  - `--lh-forest-label: #9fb3a5`
  - `--lh-forest-fog-label: #4d5f53`
- Test: `tests/forest-view.test.tsx`, with linkedom and `createRoot` + `act`. Follow `tests/dock-height.test.tsx`: stub `ResizeObserver`, `getComputedStyle`, `fetch` and `HTMLCanvasElement.prototype.getContext` (returning a no-op proxy).

**Interfaces:**
- Consumes:
  - from Task 1: `ForestSnapshot`, `formatCoverage`;
  - from Task 2: `forestLevel`, `visibleTopics`, `pickLabels`, `layoutClearing`, `CLEARING_R`, `REGION_K`, `CLEARING_K`, `LABEL_BUDGET`;
  - from core: `chainsForSelection` (`src/core/chains.ts`) and `propositionSessionHref`;
  - from `components/graph-canvas.ts`: `fitTransform` and `pickNearest`;
  - `useServerEvent` (`components/server-events.tsx`).
- Produces:
  - `export function ForestView(): JSX.Element`;
  - `export class ForestCanvasRenderer`:
    - `constructor(canvas: HTMLCanvasElement, callbacks: ForestCallbacks, initialCamera?: ForestCamera | null)`;
    - methods `setData(model: ForestModel, chains: readonly GraphChain[], colors: ForestColors, fontFamily: string)`, `fitWorld()`, `flyToTopic(id: string)`, `destroy()`.
  - `ForestCallbacks`:
    ```ts
    {
      onTopicClick(id: string): void;
      onIdeaClick(nodeId: string, screen: { x: number; y: number }): void;
      onStageClick(): void;
      onCameraMove(cam: ForestCamera): void;
    }
    ```
  - `ForestColors` holds the tokens above as CSS colour strings. Canvas accepts them directly, so there is no hex conversion.

The renderer has no unit tests, like `GraphCanvasRenderer`; it is exercised live. Its pure parts live in Task 2. Build it in this order:

- [ ] **Step 1: Write the failing view tests** (`tests/forest-view.test.tsx`), with `fetch` stubbed:
  - `shows the generate step with no world`: `{model:null, graph:…}` renders text containing `npm run world:generate`, then `npm run world:layout`, plus a link with `href="/graph"`.
  - `shows the layout step when topics have no positions`: a model with `unpositioned > 0` and `topics: []` renders `npm run world:layout`, and not `world:generate`.
  - `renders the coverage line`: a model with `{mapped:7,total:10000}` renders "Mapped 0.07% of undergrad STEM".
  - `lists uncharted ideas`: 2 uncharted node ids render a collapsed "Uncharted (2)" control. When expanded, it lists their `name`s.
  - `shows waiting ideas`: `unplaced: 3` renders "3 ideas waiting to be placed". With `0` the line is absent.
  - `idea card shows statement, chains and sessions`: render `ForestIdeaCard` directly with a node, its chains and `nodeSessions`. The statement text appears, each chain's premises ⟹ conclusion appear, and each session renders as a link whose `href` is `propositionSessionHref(node, chatId)`.

- [ ] **Step 2: Run them to see them fail.**

- [ ] **Step 3: Implement `ForestCanvasRenderer`.** Mirror `GraphCanvasRenderer`'s mechanics (read `components/graph-canvas.ts` lines 563–1240 first):
  - **Pan and zoom:**
    - d3-zoom handles pan and pinch, with `dblclick.zoom` and `wheel.zoom` removed.
    - The custom wheel uses `delta = -deltaY*(deltaMode===1?0.05:deltaMode?1:0.002)`, eased toward the target with a 45 ms time constant and anchored at the cursor.
    - `scaleExtent` is `[0.5*fitK, 12]`, where `fitK` comes from `fitTransform` over the topic bbox with a padding of 40.
  - **Drawing loop:** an on-demand rAF with a dirty flag; `syncSize()` with dpr; a `ResizeObserver` that keeps the centre point fixed; and `CLICK_SLOP = 4`.
  - **Draw order** (world coordinates, line widths divided by `k`; cull with `visibleTopics(…, padPx = 2*CLEARING_R*k + 40)`):
    1. **Background** fill `bg`.
    2. **Trees.** Every visible fogged topic is a tree disc of radius `CLEARING_R*0.9`, filled `tree` with a `treeEdge` stroke, batched into one `Path2D`. Once a disc is under 1.5 screen px, draw a 1.5 px dot instead.
    3. **Light.** Each lit topic gets a radial gradient from `light` at alpha `glow` to transparent, with radius `CLEARING_R*(1.4 + glow)`. At world level, also draw a 2 screen-px speck so a single idea is still visible at full fit.
    4. **Trails**, from region level up. Draw dotted lines (`setLineDash([4/k, 6/k])`, `trail` colour) between topic centres. Cross-degree trails are 1.5× wider.
    5. **Degree names.** Faint italic text at each region (fontFamily italic, `label` colour), 22 screen px. Alpha is 0.55 at world level, fading linearly to 0 by `k = REGION_K*2`.
    6. **Topic labels**, from region level up, for `pickLabels(visible, LABEL_BUDGET)`, at 12 screen px. Lit topics show `name` in `label`. Fogged topics show `"<name> ?"` in `fogLabel`.
    7. **Clearings.** At clearing level, for each visible lit topic, draw its ideas. Positions come from `layoutClearing(topic.ideas, chains, topic, CLEARING_R)`, cached by `topic.id + ideas.join()`. Draw chain edges as thin lines and ideas as 6-screen-px discs coloured by state: seen = `label` at 0.6 alpha, held = `#6fbf73`, fast = `light`. Each idea's label sits beside it, 11 screen px.
  - **Clicks:**
    - At world and region level, `pickNearest` over visible topics (`maxDist = CLEARING_R*k + 10`) calls `onTopicClick`.
    - At clearing level, idea picking calls `onIdeaClick` first, then falls back to the topic.
    - A click on empty stage calls `onStageClick`.
  - **`flyToTopic(id)`** animates (ease, about 400 ms) to `k = CLEARING_K*1.6`, centred on the topic.

- [ ] **Step 4: Implement `ForestView` and `ForestIdeaCard`.**
  - **Fetching.** `ForestView` fetches `/api/forest` on mount. It refetches on `useServerEvent("activity-changed")`, on the window event `lh:graph-revision`, and on `window` `focus`; the placer writes placements in the background after extraction, so focus catches those.
  - **Colours** are read once per data load from `getComputedStyle(document.documentElement)`.
  - **Camera** is persisted in localStorage under `lh.forest.camera.v1`, debounced 250 ms, with every access in try/catch. With no stored camera, call `fitWorld()`.
  - **Topic clicks.** A click on a topic at world or region level calls `flyToTopic`. At clearing level, `onTopicClick` does nothing.
  - **Overlays:**
    - top-left: the coverage line (`Mapped ${formatCoverage(...)} of undergrad STEM`), plus the "ideas waiting to be placed" line when `unplaced > 0`;
    - bottom-left: the collapsible "Uncharted (n)" list, where clicking a name opens the idea card;
    - the idea card, positioned near the click point and closed on stage click or Escape.
  - **Idea card.** `ForestIdeaCard({ node, chains, sessions, fileSources, nodeSessions })` shows the statement, each chain from `chainsForSelection([node], chains)` as premises ⟹ conclusion using node names, and the sessions as `Link`s (file sources as plain text). This is the same content as the graph view's inline card.
  - **Empty states** are as in the Step 1 tests, styled with existing Tailwind tokens.

- [ ] **Step 5: Run the view tests to see them pass.** Then run `npm run typecheck` and `npm run lint`.

- [ ] **Step 6: Commit** with the message "Forest view: fog-of-war canvas with region and clearing zoom".

---

### Task 5: Forest at home, Graph one click away

**Files:**
- Modify:
  - `components/home.tsx`: a prop `view: "forest" | "graph"`, defaulting to `"forest"`, which renders `ForestView` or `GraphView` in the existing `<main>`;
  - `app/page.tsx`: `view="forest"`;
  - `src/core/keyboard.ts`: the `jump-graph` binding stays `mod+g` and is relabelled "Graph view"; add `{ id: "jump-forest", label: "Forest view", binding: "mod+shift+g" }` to the action union and list;
  - `components/keyboard-shortcuts.tsx`: `jump-graph` → `router.push("/graph")`, and `jump-forest` → `router.push("/")`.
- Create: `app/graph/page.tsx`, a copy of `app/page.tsx` with `view="graph"`.
- Test: `tests/keyboard.test.ts` if it exists (add the `jump-forest` entry assertions), and `tests/home-view.test.tsx` (SSR, `renderToStaticMarkup`).

**Interfaces:**
- Consumes: `ForestView` (Task 4) and `GraphView` (existing).
- Produces: routes `/` (forest) and `/graph` (the existing graph canvas).

- [ ] **Step 1: Write the failing tests:**
  - **The view switch.** `Home` with `view="graph"` renders the switch with "Graph" marked current (`aria-current="page"`). With the default, it renders "Forest" as current. Both entries are `Link`s to `/` and `/graph`.
  - **The shortcut list** contains `jump-forest` bound to `mod+shift+g`.
  - **Graph off.** When `rendering` is false, `MinimalHome` still renders, as today, for both views.

- [ ] **Step 2: Run them to see them fail.**

- [ ] **Step 3: Implement.**
  - **The switch** is a small segmented control (Forest | Graph) in `Home`'s floating header, next to `SidebarToggle`, using the existing `button-group` UI.
  - **The LH-mark link** in the sidebar stays `href="/"`, which is now the forest.

- [ ] **Step 4: Run the tests, then the full suite.** Run `npm test`. Expected: only the 18 known failures. Then run `npm run typecheck` and `npm run lint`.

- [ ] **Step 5: Live check (controller, not a subagent).**
  - Start the dev server with `npm run dev`.
  - Open `/`.
    - With Isaac's real data (math generated, not laid out), it shows the `world:layout` empty state.
    - With a temporary `LH_DATA_DIR` holding a dry-run-laid-out copy of the math world, pan and zoom through all three levels.
  - Confirm `/graph` still shows the old canvas.
  - Take a screenshot as proof.

- [ ] **Step 6: Commit** with the message "Forest is the home page; Graph moves to /graph".

---

## Out of scope (later plans)

- **Plan 3, levelling:** real held and fast states (via `buildForest`'s `stateOf`), decay dimming, XP, levels, and moment animations, including the first cross-degree trail milestone. `ForestTrail.crossDegree` is already there for it to use.
- **Plan 4, context layers:** the `world_lookup` tool.
- **Not planned:** a 3D map. That decision waits for the layout's stress report.
