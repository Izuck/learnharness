/**
 * The registry of CLI processes kept alive between stream calls (forest spec C): at most one per
 * lesson (owner + session ID). A process is registered in one of two ways:
 *   - waiting on tool results: its turn ended on admitted tool calls whose MCP requests are held
 *     until pi calls back with the results (LIVE_PROCESS_IDLE_TIMEOUT_MS);
 *   - idle: its turn ended normally and stdin stays open for the learner's next message
 *     (IDLE_TURN_TIMEOUT_MS, at most MAX_IDLE_PROCESSES, least recently used killed first).
 * Whatever is registered is owned by the registry until it is taken back out: a timeout, an
 * eviction or killAllLiveProcesses() kills it.
 */
export type LiveProcess = { readonly owner: symbol; readonly sessionId: string | undefined; kill(): void };

// Tools usually call back within seconds, but a question tool holds its call until the learner
// answers. Past this, the process is killed and the answer starts a fresh one with a full replay.
// It stays under MCP_TOOL_TIMEOUT so the process is killed before the CLI gives up on its own.
export const LIVE_PROCESS_IDLE_TIMEOUT_MS = 10 * 60_000;

/** Test seam (runner.ts's pdfModelOverride idiom). */
export const liveProcessIdleTimeoutMs = { current: LIVE_PROCESS_IDLE_TIMEOUT_MS };

/** How long a finished lesson turn keeps its process for the learner's next message. */
export const IDLE_TURN_TIMEOUT_MS = 30 * 60_000;

/** Test seam, as liveProcessIdleTimeoutMs. */
export const idleTurnTimeoutMs = { current: IDLE_TURN_TIMEOUT_MS };

/** Idle processes kept at once, across lessons; each is a whole CLI process. */
export const MAX_IDLE_PROCESSES = 3;

type Entry = { timer: NodeJS.Timeout; idle: boolean };

// Process-wide, so a re-evaluated module (dev server reloads) still sees, evicts and shuts down
// the processes an earlier copy kept. Insertion order is recency: registering again moves a
// process to the end.
const REGISTRY = Symbol.for("learnharness.claude-code.live-processes");
const registry = globalThis as typeof globalThis & { [REGISTRY]?: Map<LiveProcess, Entry> };
const liveProcesses = (registry[REGISTRY] ??= new Map<LiveProcess, Entry>());

function register(process: LiveProcess, idle: boolean, timeoutMs: number): void {
	removeLiveProcess(process);
	// One live process per lesson: a newer one supersedes whatever else that lesson left behind.
	for (const other of [...liveProcesses.keys()]) {
		if (other.owner === process.owner && other.sessionId === process.sessionId) evict(other);
	}

	const timer = setTimeout(() => evict(process), timeoutMs);
	timer.unref();
	liveProcesses.set(process, { timer, idle });
}

function evict(process: LiveProcess): void {
	removeLiveProcess(process);
	process.kill();
}

/** A process whose held MCP calls wait for pi's tool results. */
export function addLiveProcess(process: LiveProcess): void {
	register(process, false, liveProcessIdleTimeoutMs.current);
}

/** A process whose turn finished normally, kept for the same lesson's next message. */
export function addIdleProcess(process: LiveProcess): void {
	register(process, true, idleTurnTimeoutMs.current);
	const idle = [...liveProcesses].flatMap(([candidate, entry]) => (entry.idle ? [candidate] : []));
	for (const oldest of idle.slice(0, Math.max(0, idle.length - MAX_IDLE_PROCESSES))) evict(oldest);
}

/** The lesson's live process, if it has one. */
export function getLiveProcess(owner: symbol, sessionId: string | undefined): LiveProcess | null {
	if (!sessionId) return null;

	for (const process of liveProcesses.keys()) {
		if (process.owner === owner && process.sessionId === sessionId) return process;
	}

	return null;
}

export function removeLiveProcess(process: LiveProcess): void {
	clearTimeout(liveProcesses.get(process)?.timer);
	liveProcesses.delete(process);
}

/** A run that is over (a sub-agent's single job) will send no next message: end its process now. */
export function endLiveSession(sessionId: string): void {
	for (const process of [...liveProcesses.keys()]) if (process.sessionId === sessionId) evict(process);
}

/** Kills every kept process (server shutdown). Kills are synchronous, so this is safe in an exit handler. */
export function killAllLiveProcesses(): void {
	for (const process of [...liveProcesses.keys()]) evict(process);
}

// Node does not end child processes when the server exits; kept CLIs would outlive it. One hook
// per server process (the registry is shared, so any module copy's killAll covers it).
const SHUTDOWN_HOOK = Symbol.for("learnharness.claude-code.live-processes.shutdown");
const hooks = globalThis as typeof globalThis & { [SHUTDOWN_HOOK]?: true };
if (!hooks[SHUTDOWN_HOOK]) {
	hooks[SHUTDOWN_HOOK] = true;
	process.once("exit", killAllLiveProcesses);
}
