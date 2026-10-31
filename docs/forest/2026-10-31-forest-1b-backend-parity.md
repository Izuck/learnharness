# Forest plan 1b: backend parity. Implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The app behaves the same whether a slot runs on the Claude Code CLI provider (Isaac's plan) or the Anthropic API provider (his key).

**Architecture:** Most changes live in LearnHarness's Claude Code provider (`src/agent/claude-code/*`). Supporting pieces go in new pure-core files (`src/core/backend-parity.ts`) and in small UI additions in the model picker, settings and stats bar. Every fallback keeps today's behaviour (a fresh process with full text replay), so a parity feature that fails is never worse than now.

**Tech Stack:** TypeScript, Next.js, pi-ai (`@earendil-works/pi-ai`), node:test via `tsx --test`, the Claude Code CLI (`claude -p --input-format stream-json --output-format stream-json`).

**Spec:** `docs/forest/2026-10-30-learnharness-fork-design.md` §11 (A–H). The plan's task letters match the spec's.

## Global Constraints

- CLI usage never touches API credits: `ANTHROPIC_API_KEY` must never reach a `claude` child, in any casing (already enforced by `toClaudeEnv`; keep it).
- The API is used only for slots Isaac points at the `anthropic` provider.
- Windows 11. Never run executables the builder compiled. Never invoke the real `claude` CLI with a prompt, except the Task 1 probe, which Isaac approves at hand-off.
- Isaac (31 Oct): "don't hesitate to modify the application on a more foundational level if something is just done poorly in the base learnharness." Fix base design problems at the root; upstream mergeability is secondary. Still name every upstream file touched in the report.
- LearnHarness architecture laws: the import law (`npm run lint`), one writer per store, append-only evidence.
- Tests use the repo's `data/`, never Isaac's data folder. The full suite has ~18 known Windows-platform failures (`auth-store`, `automatic-updates`, `chatgpt-auth`, `claude-code-stream` ×2 for file mode and SIGKILL, `data-dir-seam`, `model-catalog` ×3, `render-sidebar`, `subscription-auth` ×2, `verify-release` ×6). Any other failure is new.
- Backend model mapping (exact ids): `claude-code:opus ↔ anthropic:claude-opus-5-5`, `claude-code:sonnet ↔ anthropic:claude-sonnet-5-5`, `claude-code:haiku ↔ anthropic:claude-haiku-5-5`. Any other `anthropic` id maps by family (an id containing `opus`, `sonnet` or `haiku`). An id with no family (for example `claude-fable-5-1`) has no CLI equivalent and is left unchanged, with a visible note.
- Every fallback is today's behaviour: fresh process plus full replay.

## Review Focus

1. **Isaac edits or retries a message, or LearnHarness compacts the lesson, while a live process is idle.** The history is no longer a prefix of what the process saw. The process must be killed and the turn replayed, never continued with a stale history. Test in Task 7.
2. **The CLI streams a tool call that the MCP bridge then refuses or never admits.** The streamed preview card must be withdrawn, and nothing executes. Test in Task 6.
3. **Isaac switches backend while a lesson is mid-question.** The open question must still accept the answer, and the next turn runs on the new backend with thinking stripped from the history. Test in Task 3 and Task 5.
4. **Several lessons are open, or the app stays idle overnight.** Idle live processes must not pile up: there is a cap and an idle timeout, and all of them die when the server exits. Test in Task 7.
5. **The plan-limit warning arrives mid-turn, or the CLI's error text changes wording.** Isaac still sees a readable message, and the raw text falls back unchanged when no pattern matches. Test in Task 4.

---

### Task 0: A native tool call no longer kills the lesson (bug, 31 October)

**Evidence:** Isaac asked a follow-up question mid-lesson (chat `chat_mvwtfm85_46269a5c`, messages 46–47). Both attempts failed with `claude CLI emitted an unsupported native tool call` (`stream.ts` `startBlock`, the `toolUse` case). The CLI's init event under the app's exact flags lists `tools: []`, but it loads every user plugin, and the "Concise" output style applies. The model emitted a tool call that is not one of the app's bridge tools. The error doesn't record its name.

**Files:**
- Modify: `src/agent/claude-code/stream.ts` (the `toolUse` case of `startBlock`, and the `toolResults` handling in `ClaudeProcess.handleLine`)
- Test: `tests/claude-code-native-tool.test.ts` (scripted fake-CLI harness)

**Interfaces:**
- A non-bridge `tool_use` block is never admitted, never executed by the app, and never shown as a card. It is logged once, by name (`console.warn("claude CLI native tool call ignored:", name)`), and the turn continues: the CLI answers unknown tools with an error result, and the model carries on.
- If the CLI then reports a successful result for that block's id (meaning the CLI ran a native tool itself), the turn fails as it does today, with the tool's name in the message: `claude CLI ran a native tool (<name>) outside the app`.

- [ ] **Step 1: Write the failing tests.**
  - A scripted stream with a `tool_use` named `Read`, followed by a CLI error tool_result for it, then text and `end_turn`. The turn finishes with the text, no tool call in the final message, and one warn naming `Read`.
  - A scripted successful tool_result for that id. The turn fails, and the message contains `Read`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** Track ignored native ids in `ClaudeTurn` and `ClaudeProcess`. Make the `toolResults` event check distinguish ignored native ids from refused bridge intents.
- [ ] **Step 4: Run all `tests/claude-code-*.test.ts`.** Expected: PASS (except the 2 known Windows failures).
- [ ] **Step 5: Commit.** Message: `forest(parity): ignore stray native tool calls instead of failing the lesson`.

---

### Task 1: Isolate the tutor from Isaac's Claude Code setup (spec A)

**Evidence already gathered (31 October):** the init event under the current flags shows 15 user plugins loaded and `output_style: "Concise"`, while `tools` and `skills` are empty. Task 1's probe should confirm that the chosen variant removes both plugins and the output style (read them from the init event too, without waiting for a model reply).

**Files:**
- Modify: `src/agent/claude-code/stream.ts` (`toClaudeArgs`)
- Create: `scripts/parity/probe-isolation.ts` (a one-off probe, committed for repeatability)
- Test: `tests/claude-code-isolation.test.ts`

**Interfaces:**
- Produces: `toClaudeArgs(input)` returns the isolated flag set chosen in Step 2. Later tasks append flags to this function without reordering it.

- [ ] **Step 1: Write the probe.** `scripts/parity/probe-isolation.ts` runs `claude` with the app's exact `toClaudeArgs` output, plus variants. It uses model `haiku` and an empty MCP config, and its system prompt says only "Answer the user's question exactly." It sends one stream-json user message: `List, verbatim, the first line of every instruction, memory, CLAUDE.md, output style or reminder you received besides this system prompt. If none, reply NONE.` For each variant it prints the reply and whether the result event reports success (that it signed in on the plan). The variants are:
  - (a) the current flags;
  - (b) `--setting-sources` set to `local`;
  - (c) `--setting-sources` set to `project`;
  - (d) (a) plus `--bare`.

  The probe uses `claudeEnv` from `scripts/world/claude-cli.ts`.
- [ ] **Step 2: Run the probe only after Isaac approves.** He approves this at the plan hand-off. It makes about 4 Haiku calls on his plan. Pick the variant that replies `NONE` (or nothing user-specific) and still signs in. Record every variant's output in the report. If no variant is clean and signs in, report BLOCKED with the outputs.
- [ ] **Step 3: Write the failing test.** `toClaudeArgs` contains the chosen isolation flags. It no longer contains `--setting-sources user` (unless that was the chosen variant). It still contains `--strict-mcp-config`, `--mcp-config`, `--tools ""` and `{"disableAllHooks":true}`.
- [ ] **Step 4: Run it.** `npx cross-env NODE_ENV=test LH_DATA_DIR= tsx --test tests/claude-code-isolation.test.ts`. Expected: FAIL.
- [ ] **Step 5: Implement.** Change `toClaudeArgs`, then update any upstream `tests/claude-code-*.test.ts` assertion that pins the old flag list. Run those tests and `tests/claude-code-isolation.test.ts`. Expected: PASS.
- [ ] **Step 6: Commit.** Message: `forest(parity A): isolate CLI agents from the user's Claude Code setup`.

---

### Task 2: Same limits, less overhead (spec G)

**Files:**
- Modify: `src/agent/claude-code/stream.ts` (`toClaudeEnv`)
- Modify: `src/agent/claude-code/launch.ts` (version check)
- Test: `tests/claude-code-limits.test.ts`

**Interfaces:**
- Produces: `toClaudeEnv(model?: Model<Api>)` sets `CLAUDE_CODE_MAX_OUTPUT_TOKENS` to the mapped API model's `maxTokens` (via Task 3's `toApiModelId` and the anthropic catalog, falling back to `128000`) and `MAX_MCP_OUTPUT_TOKENS` to `50000`. `createClaudeLauncher` memoizes a successful version check per binary path for the life of the process, and re-checks after a launch failure.

- [ ] **Step 1: Write the failing tests.**
  - The env for model `opus` has `CLAUDE_CODE_MAX_OUTPUT_TOKENS` equal to the catalog `maxTokens` of `claude-opus-5-5`.
  - `MAX_MCP_OUTPUT_TOKENS === "50000"`.
  - The API key is still stripped.
  - With an injected `readVersion` counter, two launches with the same binary call it once.
  - After a launch error, the next launch calls it again.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** Thread the model into `toClaudeEnv` at its one call site (`stream.ts` ~line 681). If Task 3 isn't merged yet, do Task 3 first: the dependency is `toApiModelId`.
- [ ] **Step 4: Run the tests.** Run them together with `tests/claude-code-env.test.ts` and `tests/claude-code-stream.test.ts`. Expected: PASS (except the 2 known Windows failures in stream).
- [ ] **Step 5: Commit.** Message: `forest(parity G): API-equal output caps; version check once per process`.

> Execution order: run Task 3 before Task 2.

---

### Task 3: Backend mapping and the one switch (spec B)

**Files:**
- Create: `src/core/backend-parity.ts`
- Create: `src/server/backend-switch.ts` (`switchBackend(to: Backend): { unmapped: string[] }`, which reads the record through `settingsStore`, applies `remapSettings` and writes it back), exported from `src/server/index.ts`
- Create: `app/api/settings/backend/route.ts` (a thin route over `switchBackend`; `app/` may import only the two barrels)
- Modify: `src/core/index.ts` (export the pure mapping for the UI)
- Modify: `components/settings/agent-section.tsx` (add a "Run on" control above the slots)
- Modify: `components/model-picker.tsx` (one-click "switch this lesson to Claude plan / API key")
- Modify: `components/stats-bar.tsx` (show the resolved CLI model)
- Modify: `src/agent/claude-code/cli-events.ts` and `stream.ts` (capture the `system`/`init` event's `model` into a new optional `cliResolvedModel` field on the output message, beside `cliContextWindow`)
- Test: `tests/backend-parity.test.ts`, plus a render test in the style of `tests/render-*.test.tsx`

**Interfaces:**
- Produces, in `src/core/backend-parity.ts`:

```ts
export type Backend = "claude-code" | "anthropic";
export const CLI_TO_API: Readonly<Record<string, string>>;   // opus→claude-opus-5-5, sonnet→claude-sonnet-5-5, haiku→claude-haiku-5-5
export function toApiModelId(cliId: string): string | null;
export function toCliModelId(apiId: string): string | null;   // by family; null when no family
export function backendOf(spec: { provider: string }): Backend | null;   // null for other providers
export function remapSpec<T extends { provider: string; id: string }>(spec: T, to: Backend): { spec: T; changed: boolean; unmapped: boolean };
export function remapSettings(record: UserSettings, to: Backend): { record: UserSettings; unmapped: string[] };   // slots + agent.models role overrides
```

- Produces: `POST /api/settings/backend` with body `{ to: Backend }`. It rewrites the settings record through the existing settings store and returns `{ unmapped }`. It is the only writer path, so the settings store stays the sole writer.

- [ ] **Step 1: Write the failing tests.**
  - Both directions round-trip for opus, sonnet and haiku.
  - `toCliModelId("claude-opus-4-8") === "opus"`.
  - `toCliModelId("claude-fable-5-1") === null`.
  - `remapSpec` keeps `thinkingLevel` and other fields.
  - Non-Anthropic providers are untouched.
  - `remapSettings` rewrites the strong, cheap and vision slots and every role override, and lists unmapped ids.
  - The route test posts `{to:"anthropic"}` against the repo `data/` settings (snapshot and restore like `tests/settings-store.test.ts`) and reads back remapped slots.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement the core and the route.**
- [ ] **Step 4: Add the UI pieces.**
  - **"Run on" control:** a two-option segmented control in `agent-section.tsx`, showing the current backend when all slots agree and "Mixed" otherwise. It calls the route and lists unmapped slots in a note.
  - **Lesson switch:** the model picker shows a one-click switch for the open lesson. It uses the existing per-chat settings route (`app/api/chats/[id]/settings`) with `remapSpec`.
  - **Resolved model:** the stats bar shows `Claude plan · <resolved model>` for CLI turns, using `cliResolvedModel`.
  - **Render test:** the control renders both options and the "Mixed" state.
- [ ] **Step 5: Run the tests.** Run them together with `npm run lint` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 6: Commit.** Message: `forest(parity B): one backend switch and model mapping`.

---

### Task 4: Same errors and a plan-limit warning (spec E)

**Files:**
- Create: `src/core/cli-errors.ts`
- Modify: `src/agent/claude-code/cli-events.ts` (parse `rate_limit_event` instead of returning `null`)
- Modify: `src/agent/claude-code/stream.ts` (map error text through `cliErrorMessage`; push a warning on rate-limit events)
- Modify: the UI surface that already shows turn errors, to show the warning as a non-blocking note. The implementer locates the existing error banner and reuses its component.
- Test: `tests/cli-errors.test.ts`

**Interfaces:**
- Produces: `cliErrorMessage(raw: string): string` and `rateLimitNotice(event: unknown): string | null`.
  - Plan or usage limit → `Claude plan limit reached. It resets {when}. Switch this lesson to your API key to keep going.` (`{when}` comes from the event's reset time when present, otherwise "soon").
  - Rate limit (429/529) → `Claude is busy right now. Try again in a moment.`
  - Not signed in → `Claude Code isn't signed in. Open a terminal and run "claude" once to sign in.`
  - Credit balance → `This request was billed to API credits and the balance is too low.`
  - Anything else → the raw text, unchanged.
- The API path's equivalent SDK errors (HTTP 429/529, 401, `overloaded_error`) map through the same function, so both backends show the same sentence.

- [ ] **Step 1: Write the failing tests.**
  - Each pattern above maps from the real CLI strings used in `tests/claude-code-stream.test.ts` ("API Error: Rate limit reached", "Credit balance is too low", `authentication_failed`).
  - An unknown string passes through unchanged.
  - `rateLimitNotice` returns text for a warning event shape and `null` for an allowed one.
  - **Event shape:** the implementer records one real `rate_limit_event` line in a fixture. Since no real CLI may be called, they take the shape from the CLI's documented stream-json output if available. Otherwise they write the parser defensively (any object with `type: "rate_limit_event"` carrying a status of warning or rejected, and an optional reset time) and say so in the report.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement and wire both backends.** Find where API-provider turn errors become the turn's `errorMessage` and route them through `cliErrorMessage` too.
- [ ] **Step 4: Run the tests.** Run them together with the claude-code test files. Expected: PASS.
- [ ] **Step 5: Commit.** Message: `forest(parity E): one error vocabulary for CLI and API; plan-limit warning`.

---

### Task 5: Strip cross-backend thinking (spec H)

**Files:**
- Create: `src/core/cross-backend.ts`
- Modify: the single place where a conversation agent's message history is handed to the engine. The implementer finds it from `src/agent/teacher-agent.ts` and `src/agent/subagents/pi-run.ts`, and wires the function there once, for every agent.
- Test: `tests/cross-backend.test.ts`

**Interfaces:**
- Produces: `stripForeignThinking(messages: Message[], target: { provider: string }): Message[]`. Assistant messages whose `provider` differs from `target.provider` have their `thinking` blocks removed. Everything else is untouched. The input array is never mutated.

- [ ] **Step 1: Write the failing tests.**
  - A `claude-code` assistant message with thinking and text, sent to `anthropic`, comes out text only.
  - A same-provider message is unchanged.
  - Tool calls and results survive.
  - The input is not mutated.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement it and wire it at the engine boundary.**
- [ ] **Step 4: Run the tests and the full claude-code test set.** Expected: PASS.
- [ ] **Step 5: Commit.** Message: `forest(parity H): drop foreign-backend thinking instead of resending it as text`.

---

### Task 6: Stream tool calls on the CLI (spec D)

**Files:**
- Modify: `src/agent/claude-code/stream.ts` (`ClaudeTurn`: `startBlock`, the `toolInputDelta` case, `admit`, and a new withdraw path)
- Test: `tests/claude-code-tool-streaming.test.ts`, using the scripted fake-CLI harness in `tests/claude-code-stream.test.ts` (`runScenario`)

**Interfaces:**
- Produces, as pi stream events matching the API provider's:
  - `toolcall_start` when a tool block starts;
  - `toolcall_delta` for each input delta, with the partially parsed arguments (already computed as `block.arguments`);
  - `toolcall_end` only at admission.
- A tool call that streamed but is not admitted (bridge refusal, cancellation, or the turn failing) is removed from `output.content` before the turn's final message, so the UI never keeps a phantom card. The admission security rule is unchanged: nothing executes without an authenticated MCP call matching the intent.

- [ ] **Step 1: Write the failing tests.**
  - A scripted stream of `send_to_user` input deltas emits `toolcall_start`, at least 2 `toolcall_delta` events whose partial `text` grows, then `toolcall_end` after admission.
  - A refused intent (the existing "refused a harness tool call before MCP admission" scenario) ends with no tool call in the final message.
  - The existing admission tests still pass unchanged.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** Keep the content index stable from start to end.
- [ ] **Step 4: Run all `tests/claude-code-*.test.ts`.** Expected: PASS (except the 2 known Windows failures).
- [ ] **Step 5: Commit.** Message: `forest(parity D): stream CLI tool calls like the API, admit unchanged`.

---

### Task 7: One live process per lesson (spec C)

**Files:**
- Modify: `src/agent/claude-code/live-processes.ts` (idle-turn processes, cap, shutdown)
- Modify: `src/agent/claude-code/stream.ts` (`ClaudeProcess.canContinueWithMessages`, `continueWithMessages`, the end-of-turn path that currently kills; and `continueLiveProcess`, which now also handles the no-tool-results case)
- Modify: `src/agent/claude-code/transcript.ts` (`toStreamJsonLine` for a plain user message, if not already suitable)
- Test: `tests/claude-code-keepalive.test.ts`, using the scripted fake-CLI harness

**Interfaces:**
- Produces:
  - `IDLE_TURN_TIMEOUT_MS = 30 * 60_000`
  - `MAX_IDLE_PROCESSES = 3` (least recently used killed first)
  - `killAllLiveProcesses()`, registered on server shutdown (`process.on("exit")` and the existing shutdown hook if there is one)
- Behaviour:
  1. When a turn finishes with stop reason `stop` and the call has a `sessionId`, the process is kept as an idle live process (stdin open). Its conversation snapshot includes the final assistant message.
  2. The next stream call for that `sessionId`, with equal configuration and a history that is the snapshot plus only new `user` messages, writes those messages to stdin and continues with a new `ClaudeTurn`.
  3. Any other case (no live process, configuration differs, history not a strict extension, edited or retried message, compaction, a tool-result case already handled by the existing path) kills the process and runs today's fresh replay.

- [ ] **Step 1: Write the failing tests** with the fake CLI:
  - **Continues:** turn 1 ends, and turn 2 (history plus one user message) reuses the same child. Assert a single spawn and that the second stdin line is the user message only.
  - **Edited history replays:** a message changed in the middle triggers kill and respawn.
  - **Configuration change replays:** a changed effort triggers kill and respawn.
  - **Idle timeout:** with `liveProcessIdleTimeoutMs` shortened, the process is killed and the next turn respawns.
  - **Cap:** a fourth idle session kills the least recently used.
  - **Shutdown:** `killAllLiveProcesses()` kills all of them.
  - **Old path intact:** the existing tool-result continuation tests still pass.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** Reuse `conversationForReuse` and `configurationForReuse` for the prefix and configuration checks. Never continue when unsure.
- [ ] **Step 4: Run all `tests/claude-code-*.test.ts`.** Expected: PASS (except the 2 known Windows failures).
- [ ] **Step 5: Commit.** Message: `forest(parity C): keep one CLI process per lesson; replay only on mismatch`.

---

### Task 8: Comparable usage (spec F)

**Files:**
- Modify: `src/server/pricing.ts` (add an estimate path)
- Modify: `components/stats-bar.tsx` (labels)
- Modify: `src/core/backend-parity.ts` (reuse `toApiModelId`)
- Test: `tests/cli-cost-estimate.test.ts`

**Interfaces:**
- Produces: `estimatedCallCost(call: Partial<CallUsage>, modelId: string): number | null`. For `claude-code:<alias>` it prices the call at the catalog rates of `anthropic:<toApiModelId(alias)>`. It returns `null` otherwise. `callCost` is unchanged, so CLI turns stay unbilled.
- The stats bar shows `≈ $x on plan` for CLI turns and the session total, keeping today's `CLI` marker as the fallback when no estimate exists.

- [ ] **Step 1: Write the failing tests.**
  - An opus CLI call with known token counts gives the same number as `callCost` for `anthropic:claude-opus-5-5` with the same counts.
  - An unknown alias gives `null`.
  - `callCost` for a CLI model is still `null` or unpriced, as today.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement it and update the labels.**
- [ ] **Step 4: Run the tests and the existing pricing and stats-bar render tests.** Expected: PASS.
- [ ] **Step 5: Commit.** Message: `forest(parity F): show estimated API-equivalent cost for CLI turns`.

---

**Execution order:** 0, 1, 3, 2, 4, 5, 6, 7, 8. Task 2 depends on Task 3's `toApiModelId`. Task 7 is last among the CLI changes so that it builds on the streaming changes from Task 6.
