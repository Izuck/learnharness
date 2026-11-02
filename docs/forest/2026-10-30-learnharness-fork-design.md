# LearnHarness fork: the forest: design

Date: 30 October 2026 · Owner: Isaac Levesque · Status: draft for Isaac's approval

This replaces the AI Tutor app. It was written in the AI Tutor repo and moves into the fork as that repo's first commit. Once the fork runs, AI Tutor is deleted (see §9).

## 1. Intent

Isaac (an engineering student at Georgia Tech) wants to learn STEM properly before he builds with it, and he wants learning to feel like progress he can see.

- **Teaching.** He likes how LearnHarness (https://github.com/amosblomqvist/learnharness) teaches: it probes for the edge of what he knows, plans a minimal route, teaches one reasoning step at a time with predict → teach → check, and runs separate practice. This fork keeps that teaching as it is.
- **Reward.** He wants Science Bowl's feeling of levelling up: you can feel your knowledge get faster and more reliable, and the syllabus is finite, which is comforting. College STEM has no natural edge, so the fork supplies one: everything in the 4-year BS degrees.
- **The forest.** Learning should feel like piecing together a map of a large, endless forest. Ideas sit as far apart as they really are in undergrad STEM. They are not packed together the way LearnHarness's graph places them.
- **Cost.** It all runs on his Claude subscription through the Claude Code CLI, never on API credits.

## 2. Goals, non-goals, anti-goals

**Goals**
- LearnHarness teaching, practice and the knowledge graph, unchanged in behaviour unless this document says otherwise.
- A fixed **world**: every topic of the 4-year BS degrees, generated once, each topic with a permanent position.
- A **fog-of-war forest** view of that world with semantic zoom (world → degree region → topic clearing → the detailed proposition graph).
- **Levelling** that is earned only by demonstrated recall: idea states, XP, an overall level, a level and coverage % for each degree, toss-up and bonus practice, and milestone moments.
- **Layered context** that every session reads: general app context, a learner profile, session context, and on-demand lookups.
- **Per-role models**, with Haiku doing all grading.

**Non-goals (for now)**
- Project-specific decisions, rederive-style decision work, the AI Tutor roadmap and loops, and the loop timer. All dropped on 30 October 2026.
- Sharing, accounts, hosting, mobile, and packaged installers.

**Anti-goals**
- XP for time spent or lessons sat through. If levels can be earned without recall, the reward is fake.
- A forest that rearranges itself. A topic never moves once placed.
- Application-flavoured nodes. The graph holds general knowledge ("RBF interpolation", not "RBF interpolation for Poisson"), so the world stays finite.
- Touching the API unasked. The API is used only when Isaac picks it (§11). Claude Code (CLI) usage, signed in with his plan, never touches API credits.

## 3. Constraints

- **Runtime.**
  - LearnHarness ≥ 0.4.0 with its Claude Code CLI provider (`src/agent/claude-code/`, added 24–29 October 2026). It runs one live `claude -p --input-format stream-json` process per lesson.
  - Usage comes out of Isaac's plan limits (shared with his other Claude use). `claude -p` signed in with a plan does not touch API credits (Anthropic help article 15036540, update of 7 October 2026). Make sure `ANTHROPIC_API_KEY` is never passed to the CLI.
- **Windows 11.** Isaac must never be asked to run an executable the builder compiled (it triggers Windows Security), so no `electron-builder` installers. Run it as `npm run dev` in a browser app window. Node scripts and Anthropic's own `claude.exe` are fine. LearnHarness's npm scripts are written for bash (`NODE_ENV=test …`); fix them for Windows only where needed.
- **License.** LearnHarness is AGPL-3.0. The fork is for personal use, so that's fine. Keep the license file.
- **Keep upstream mergeable.** Make the fork a GitHub fork under Isaac's account with an `upstream` remote. Put new work in new modules and touch existing LearnHarness files in as few places as possible, so upstream releases (it ships often) can be merged.
- **Follow LearnHarness's architecture laws** (`docs/architecture.md`):
  - imports point inward;
  - each store has exactly one writing system;
  - writes go to append-only evidence, and anything that can be recomputed is derived, not stored.
  - Its lint rules enforce the import law, so lint must pass.

## 4. Decided by Isaac

1. Fork LearnHarness (chosen over rebuilding its teaching inside AI Tutor).
2. LearnHarness teaching is the base: "it does a very good job."
3. The edge of the world is the 4-year BS degrees.
4. Fog-of-war forest (chosen over hex tiles and a parchment chart). Zoomed in, it is still a detailed graph.
5. Distances are true to the domain. Separate things appear far apart, unlike LearnHarness's automatic placement.
6. When learning for a project, the knowledge tree is plotted as if learning the concepts for their own sake. The tree always goes to the lower level and stays independent of the application. This keeps the knowledge base finite.
7. There should be a framework every session reads: general context about the software, plus a more specific context for the session.
8. Grading always uses Haiku. Model roles are configurable the way LearnHarness's are (his example: Opus creates lessons, Sonnet builds questions, Haiku grades).
9. AI Tutor is retired and deleted, but only once the fork runs.
10. Rederive and project decisions are out for now.

## 5. The world

**What it is.** One file holding every topic of these degrees:
- mathematics, physics, electrical engineering, computer science, chemistry, mechanical engineering, biology, earth & space science.
- computer, civil, environmental and nuclear engineering, materials science & engineering, and biomedical engineering (Isaac, 2026-11-02): smaller connecting fields whose anchors sit between the degrees they draw on.
- *(builder's call: Science Bowl's categories plus the three engineering/CS degrees Isaac's work touches; the list is a config array so Isaac can add degrees)*

**Topic grain.** About one lecture-week of a standard course, for example "Gaussian quadrature" or "pn junctions", not "Numerical methods" and not a single formula. Each topic has:
- `id` (a permanent slug);
- `name` and a one-line `scope`;
- `degrees` (one or more) and `course` (the typical course it belongs to);
- `prereqs` (topic ids);
- `position` (x, y in world units).

**Generation.**
- It's a one-time Node script that drives the Claude Code CLI with Opus, one degree at a time, from standard curricula (typical required and common elective courses of an ABET-accredited or equivalent BS).
- It writes `data/world/topics.json` and a human-readable `data/world/WORLD.md`.
- A topic shared by several degrees ("linear algebra", "Fourier analysis") appears once and lists all of them.
- Expect very roughly 3,000–5,000 topics (an estimate). The script can resume, and it runs in batches small enough not to drain a day's plan usage in one go.

**Layout.**
- Computed once and saved with the topics.
- Degrees are large regions. Topics that share courses and prerequisites cluster, and topics shared between degrees sit between their regions.
- Distances should read as "how far apart these are in an undergrad's studies".
- Degree anchors are derived from the generated topics, not only hand-placed: at the first layout, the overlap of every pair of degrees (a topic shared by k degrees weighs 1/(k−1)) becomes a distance, classical MDS embeds it, and the result is aligned (scale, rotation or reflection, shift) to the hand-drawn map so the approved orientation holds. The anchors are stored in `topics.json` and reused afterwards; degrees with too little data keep their hand-drawn anchor. The layout script reports the 2D and 3D stress of the embedding, which decides whether the map ever needs a third dimension.
- After the first save, positions never change. A topic added later is placed into empty space near its prerequisites.

**Placing ideas.**
- Every proposition LearnHarness's extraction pipeline adds to the graph is assigned to one world topic by a new **placer** step that runs after the merger (Sonnet).
- The placer reads the proposition's statement and the topic list (narrowed first by text search), then appends `{nodeId, topicId, placedAt}` to `data/world/placements.jsonl`. That ledger is owned by the new system below.
- It never writes LearnHarness's graph ledgers.
- If nothing fits, it records `topicId: null` and the node shows in an "uncharted" margin. That signals a gap in the world file, not an error.
- Application-flavoured propositions (decision 6) are a teaching problem, not a placement one. The teacher and extractor prompts gain one instruction: state propositions in general form.

**Ownership.** A new **Cartographer** system owns `data/world/*` (the topics file, layout and placements). It follows the sole-writer law.

## 6. The forest view

A new view, which becomes the home page. LearnHarness's existing graph canvas stays reachable as "Graph". Rendering uses the same hand-rolled Canvas 2D approach LearnHarness already uses (`components/graph-canvas.ts`).

**The world level.**
- Dark forest with faint italic degree names.
- At true scale your learned topics are small lit specks. That honest "endless forest" feeling is intended.
- Coverage line: "Mapped 0.07% of undergrad STEM".

**The region level.**
- Topic names appear, fogged with a "?" until you have any idea placed there.
- Learned topics are lit clearings whose brightness reflects their ideas' states.

**The clearing level.**
- The detailed proposition graph for that topic, drawn from LearnHarness's stored chains (premises jointly ⟹ conclusion), placed inside the clearing.
- Each idea is coloured by its state (§7).
- Clicking an idea opens its statement, its chains, and the sessions it came from (LearnHarness provenance).

**Trails.**
- A trail is drawn between two topics when a stored chain has members in both. Trails are derived, never stored.
- The first trail joining two different degrees is a milestone.

**Zoom.** Continuous scroll zoom with level-of-detail switching, not three separate pages. Positions are world coordinates, so nothing moves between levels.

The approved look is the "fog-of-war forest" mockup from brainstorming (dark green trees, warm gold light for learned clearings, dotted trails).

## 7. Levelling

All levelling state is **derived** from evidence: teaching sessions and practice sessions (both LearnHarness chat records), plus two new evidence ledgers, toss-up records and Haiku practice verdicts (see "Evidence" below). LearnHarness 0.4 no longer contains the problem-set pipeline described in its architecture doc §7. Practice means the chat-based practice session (`src/agent/tools/practice.ts`, `prompts/practice/*`). Nothing stores a level. This is a deliberate departure from LearnHarness's 29 September 2026 ruling that practice is "strengthening, not assessment" with no levels. The fork adds levels on top, as a derived view, and leaves LearnHarness's practice behaviour intact.

**Idea states:**

| State | Earned by | Look |
|---|---|---|
| Fogged | Not in the graph | Hidden under trees |
| Seen | Extracted from a teaching session | Dim |
| Held | Demonstrated cold, in a later session than the one it was taught in: either a practice problem that targets it, confirmed solved by Haiku at hint rung R1 or lower, or a correct toss-up | Green |
| Fast | Held, then a toss-up answered correctly within its time limit, in a new form, with confidence ≥ 75% | Gold |

**Decay (builder's call, flagged for Isaac).** A held or fast idea that goes unpractised drops one state after an interval that grows with each successful recall (spaced-repetition style; start at 7 days and double each time). It never drops below seen. Fading ideas show a dimming glow so they invite review.

**XP and levels:**
- XP comes only from state transitions upward: seen +1, held +5, fast +10, regaining a decayed state +3.
- Overall level from total XP on a gently rising curve. Each degree also has its own level and its own **coverage %**: the share of that degree's topics with at least one held idea. That finite denominator is the Science Bowl edge.

**Practice modes:**
- **Toss-ups** (new). Rapid single-idea recall drawn from held or seen ideas, mixed across topics, never naming the target.
  - Timed: the clock starts when the question is shown, and the limit is set by the question's length (builder tunes it).
  - Multiple-choice toss-ups are graded in code.
  - Short-answer toss-ups are graded by Haiku against the committed answer.
  - A toss-up session is about 10 questions.
- **Bonuses.** LearnHarness's existing practice sessions, otherwise unchanged, which chain several ideas.

**Evidence (my calls):**
- **Untagged problems don't count.** Only problems with `target` proposition ids count toward levelling. The practice agent's prompt gains one instruction: always tag targets when the material is in the graph. Topic-only problems (nothing in the graph) never move states.
- **Haiku confirms every concluded problem.** After each practice `conclude`, a Haiku grading job reads:
  - the problem statement;
  - the committed `modelSolution`;
  - Isaac's submissions;
  - the agent's outcome and hint rung.

  It returns `confirmed: true/false` plus one line of reasoning, and appends it to `data/progress/verdicts.jsonl`. The practice agent's self-reported outcome alone never earns Held.
- **One solved composition problem lifts every target.** A confirmed `solved` (R0–R1) composition problem lifts every target in it to Held.
- **Ledgers.** Toss-ups append to `data/progress/tossups.jsonl`. A new **Scorekeeper** system owns `data/progress/*` (sole writer), and levels are a pure fold over these ledgers plus the chat records.

**Moments:**
- A brief, restrained animation for each of these: a topic fully lit (every placed idea held), a first trail between two degrees, a level up, and a degree coverage milestone (each 5%).
- LearnHarness's voice rules (no praise, no hype) still apply to the teacher. The reward lives in the map, not in the prose.

## 8. Context and models

**Context layers.** Every session's system prompt is assembled in this order, so the stable parts form a prefix that Anthropic's prompt cache reuses cheaply:

1. **General context** (static, one file, `prompts/shared/00-app.md` or LearnHarness's equivalent prompt-segment slot). It covers what the app is, the world and forest, how levelling works, the rule that propositions are stated in general form, and the file formats. It should be short.
2. **Learner profile** (`data/profile/PROFILE.md`, owned by a new **Profiler** job, Sonnet). It is regenerated after each teaching or practice session ends, and covers:
   - strengths by degree;
   - recurring misconceptions, with the evidence for each;
   - how Isaac likes to be taught (from his thinking fields and requests);
   - recent activity.

   It's capped at about 1,500 tokens. It is a digest, never the raw graph.
3. **Session context.**
   - For teaching, this is what LearnHarness already carries in the conversation (goal, probe assessment, plan) plus one short added block: the world topics the session is heading into, each with its idea-state counts.
   - It does **not** preload graph content. LearnHarness ruled on 23 September 2026 that "the graph never writes into a lesson unbidden", after a semantic top-K injection experiment, and the fork keeps that ruling (my call).
   - For practice: the targets and their states.
4. **On demand.** LearnHarness's graph tools (`list_sessions`, `list_propositions`, `find`, gated by the `graphTools` setting, which the fork turns on), plus a new `world_lookup` tool (a topic by name, its prerequisites, its placed ideas and their states). The teacher and prober pull past misses and neighbouring ideas through these tools when they need them.

Graphify was considered as the context store and rejected: it builds graphs from existing documents and code, while this graph is made by the sessions themselves. Two ideas were borrowed from it: the profile as a short report file, and token-budgeted neighbourhood queries.

**Model roles.** These are set through LearnHarness's existing per-role model settings (`config.ts` `ModelRole`, settings resolution), with defaults:

| Role | Default | Notes |
|---|---|---|
| prober | Opus | Precision here caps the plan's quality |
| teacher | Opus | Writes lessons and its own predict/check questions in the flow |
| practice session agent | Sonnet | Poses bonus problems and runs the hint ladder |
| tossup generator (new) | Sonnet | |
| **grader** (new role) and **all grading** | **Haiku** | Applies to practice confirmations, toss-up short answers, and the verdict on free-recall/explain checks |
| extractor, auditor | Sonnet | Mistakes here persist in the forest |
| placer (new), profiler (new) | Sonnet | |
| researcher, pdfReader, visualMaker, demoBuilder | LearnHarness defaults | |

How Haiku grading works in teaching (my calls):
- **The grader is a new `grader` role.** LearnHarness 0.4 has none; free recall is graded by the teacher in prose, and its `ModelRole` has eight roles.
- **The Haiku verdict is binding on what Isaac is shown.** When he answers a free-recall check, Haiku grades it against the teacher's committed answer, and the verdict is shown on the answer card. It then goes to the teacher along with Isaac's full answer and thinking fields. The teacher may disagree in its prose (for example, "the grader marked this right, but your thinking shows X"), but it can't change the recorded verdict.
- **Lesson checks don't feed levelling.** Lessons only make ideas Seen.
- **Multiple choice stays graded in code.**
- **Keep Haiku warm.** Hold a warm Haiku grader process (`stream-json`, the same pattern as the lesson process) while a lesson or toss-up round is open, so a grade costs model time only, not a CLI start.
- **Toss-up timing.** It is measured to the moment Isaac submits. Grading happens afterwards.
- **One seam.** This changes LearnHarness's explain-check flow, so keep it behind one seam.

**Plan usage (my calls).** All background work runs through LearnHarness's existing background semaphore (`bg-llm-semaphore.ts`):
- The placer runs once per extraction run, as a batch.
- The profiler runs once when a session ends, debounced to at most once per hour.
- Practice confirmations are one Haiku call per concluded problem.
- Settings get one switch, "background work: normal / minimal". Minimal skips the profiler and places nodes only when the forest view opens.

## 9. Running it, and retiring AI Tutor

**Running it:**
- `npm run dev`, opened in an Edge or Chrome app window.
- A Start-menu and desktop shortcut runs a Node launcher through a `.vbs` (no console window), the same pattern AI Tutor used in `scripts/launch.mjs` and `scripts/launch-hidden.vbs`. Copy and adapt those before AI Tutor is deleted.
- The data folder lives outside the repo (set `LH_DATA_DIR`) so a fresh clone or an upstream merge never touches it.

**Retiring AI Tutor:**
1. Once the fork runs end to end (one lesson, one practice session and one toss-up round on Isaac's plan, with the forest showing the results), confirm with Isaac.
2. Then delete `C:\Users\isaac\Documents\AITutor`.
3. Before deleting, move `docs/handoff-learn-skill.md` (a separate `/edge` Claude Code skill handoff) and this document out of it.
4. AI Tutor's `data/` (old loops and flashcards) is not migrated.

## 10. Left to the builder

- **Fork mechanics.** Fork into Isaac's GitHub account, add the `upstream` remote, and work on `main` of the fork with small commits as Isaac Levesque <isaac.a.levesque@gmail.com>.
- **Learning LearnHarness first.** Read `docs/architecture.md`, `docs/vision.md` and `docs/development.md`, and verify every LearnHarness file or name this document mentions against the current code. The architecture doc is dated in places: its §7 problem-set pipeline is gone in 0.4, and practice is chat-based.
- **Building the world.** The world generation prompt, the exact topic grain, the layout algorithm, and the toss-up time limits.
- **Where code lives.** The module layout of the new systems (Cartographer, Profiler, toss-ups, the placer stage) inside LearnHarness's layers, keeping lint clean.
- **The forest view's look.** Fine visual design of the forest, within the approved mockup's direction.
- **Testing.** Tests in LearnHarness's style (deterministic, no LLM, no network) for:
  - state derivation, XP and decay;
  - trail derivation;
  - placement-ledger merging;
  - context assembly order.

## 11. Backend parity (added 31 October 2026)

Isaac saved an Anthropic API key in the app (Settings → Keys) as well as connecting Claude Code. He wants the app to behave the same whichever backend runs it: "usage in the app to not differ between if i use cli or api". The no-API anti-goal (§2) now reads: the API is used only when Isaac picks it. Claude Code (CLI) usage still never touches API credits.

He approved all of these fixes ("Plan all of them"):

- **A. Keep Isaac's personal Claude Code setup out of the tutor.** CLI-backed agents load `~/.claude` user settings. That can bring in plugins, output styles, memory, and his global CLAUDE.md, whose "write math in Unicode" rule contradicts the app's LaTeX. API agents load none of this. Use the most isolated CLI configuration that still signs in with his plan and still reaches the MCP tool bridge.
- **B. One backend switch.** A single control, "Run on: Claude plan / API key", remaps every model slot and per-role override to the matching model on the other backend. The mapping is `opus ↔ claude-opus-5-5`, `sonnet ↔ claude-sonnet-5-5` and `haiku ↔ claude-haiku-5-5`. The open lesson's model picker gets the same one-click switch. On the CLI, the stats bar shows the concrete model the CLI resolved.
- **C. One live CLI process per lesson.** Keep the `claude` process alive across ordinary turns, not only while a tool result is pending. A new learner message is then written to stdin instead of replaying the whole lesson as flattened text. Any mismatch (history no longer a prefix, changed configuration, compaction, idle timeout, app restart) falls back to today's full replay.
- **D. Stream tool calls on the CLI.** Teaching prose (`send_to_user`) and tool cards stream as they are generated, as on the API. Execution still waits for MCP admission, and a previewed call that is never admitted is withdrawn.
- **E. Same errors.** CLI limit, rate and sign-in errors become the same friendly messages the API path shows. A plan-limit warning appears when the CLI reports one.
- **F. Comparable usage.** CLI turns show an estimated equivalent API cost ("≈ $x on plan") from the catalog price of the mapped model.
- **G. Same limits, less overhead.** Raise the CLI output caps to the API model's limits. Run the CLI version check once per server process, not once per launch.
- **H. Switching backend mid-lesson.** Thinking blocks produced on one backend are dropped when the history is sent to the other, never resent as plain text.

These can't be made equal, and that is accepted: the CLI has no thinking-off, and parallel tool calls arrive one at a time on the CLI.
