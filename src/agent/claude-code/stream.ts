import { type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { isDeepStrictEqual } from "node:util";

import {
	createAssistantMessageEventStream,
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Message,
	type Model,
	type SimpleStreamOptions,
	type StopReason,
	type StreamFunction,
	type ThinkingLevel,
	type ToolCall,
	type ToolResultMessage,
	type TranscriptContext,
	type UserMessage,
} from "@earendil-works/pi-ai";
import type { AnthropicEffort } from "@earendil-works/pi-ai/api/anthropic-messages";
import { ANTHROPIC_MODELS } from "@earendil-works/pi-ai/providers/anthropic.models";
import { parseStreamingJson, parseToolCallArguments } from "@earendil-works/pi-ai/utils/json-parse";

import { externalCliEnv } from "../../core/auth-env.ts";
import { toApiModelId } from "../../core/backend-parity.ts";
import type { LhMessage } from "../../core/native-messages.ts";
import { ClaudeLaunchError, createClaudeLauncher } from "./launch.ts";
import { parseCliLine, type CliBlock, type CliEvent, type CliUsage } from "./cli-events.ts";
import { ClaudeCodeError } from "./constants.ts";
import { cliErrorMessage, type RateLimitInfo } from "../../core/cli-errors.ts";
import { ContextWindowProbe } from "./context-window.ts";
import { addIdleProcess, addLiveProcess, getLiveProcess, liveGeneration, removeLiveProcess, type LiveProcess } from "./live-processes.ts";
import { configurationForReuse, conversationForReuse } from "./reuse-context.ts";
import { BRIDGE_SERVER_NAME, createToolBridge, toolNameFromMcp, type PendingToolCall, type ToolBridge } from "./tool-bridge.ts";
import { toClaudeInput, toContinuationContent, toStreamJsonLine } from "./transcript.ts";

type RunClaudeOptions = { cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal };

type ClaudeChild = ChildProcessWithoutNullStreams | null;
export type RunClaude = (args: string[], options: RunClaudeOptions) => ClaudeChild | Promise<ClaudeChild>;

// A held MCP call lasts until pi calls back with the tool result, which for a question tool is
// whenever the learner answers; this must outlast the live-process idle timeout so the CLI never
// times out first.
const MCP_TOOL_TIMEOUT_MS = 30 * 60_000;

const PRIVATE_FILE_MODE = 0o600;

const EFFORTS: Record<ThinkingLevel, AnthropicEffort> = {
	minimal: "low",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "max",
};

const STOP_REASONS: Record<string, StopReason> = {
	end_turn: "stop",
	pause_turn: "stop",
	stop_sequence: "stop",
	max_tokens: "length",
	tool_use: "toolUse",
	refusal: "error",
};

// A model that keeps calling tools the app does not offer would otherwise spin the turn, one real
// CLI request per message. Three native-only messages in a row are tolerated; the fourth fails.
const MAX_NATIVE_ONLY_MESSAGES = 3;
const NATIVE_RESULT_PREVIEW_CHARS = 200;
// The CLI reports the plan-limit status (rate_limit_event) right AFTER a message's message_stop and
// before its final result line. A finished response waits this long for that trailer so the
// status can ride the message; the next line of any kind, or the process closing, ends the wait sooner.
const TRAILER_GRACE_MS = 500;
const TOOL_USE_ERROR_PREFIX = "<tool_use_error>";

const REFUSAL_MESSAGE = "The model refused to complete the request";
const ABORT_MESSAGE = "Request was aborted";
const START_FAILED_MESSAGE = "claude CLI failed to start";
const NO_STOP_REASON_MESSAGE = "claude CLI ended the message without a stop reason";

export function toEffort(level: ThinkingLevel | undefined): AnthropicEffort {
	return level ? EFFORTS[level] : "medium";
}

type ClaudeArgsInput = {
	model: string;
	effort: AnthropicEffort;
	systemPromptFile: string;
	mcpConfigFile: string;
	allowedTools: string[];
};

export function toClaudeArgs(input: ClaudeArgsInput): string[] {
	return [
		"-p",
		"--input-format",
		"stream-json",
		"--output-format",
		"stream-json",
		"--verbose",
		"--include-partial-messages",
		"--model",
		input.model,
		"--effort",
		input.effort,
		"--system-prompt-file",
		input.systemPromptFile,
		"--tools",
		"",
		"--strict-mcp-config",
		"--mcp-config",
		input.mcpConfigFile,
		// "local" keeps the owner's user plugins, output style and CLAUDE.md out of the tutor's agents.
		"--setting-sources",
		"local",
		"--settings",
		JSON.stringify({ disableAllHooks: true }),
		"--disable-slash-commands",
		"--no-session-persistence",
		"--permission-prompts",
		"none",
		...(input.allowedTools.length > 0 ? ["--allowedTools", input.allowedTools.join(",")] : []),
	];
}

function createOutput(model: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "pending",
		timestamp: Date.now(),
	};
}

function isBridgeToolName(name: string): boolean {
	return name.startsWith(`mcp__${BRIDGE_SERVER_NAME}__`);
}

// The CLI's own words for a failed response, in the app's shared error vocabulary.
function getAssistantErrorMessage(error: string, text: string, rateLimit: RateLimitInfo | undefined): string {
	return cliErrorMessage(text || error, "claude-code", { code: error, rateLimit });
}

class ClaudeTurn {
	private readonly output: AssistantMessage & Pick<LhMessage, "cliContextWindow" | "cliResolvedModel" | "cliRateLimit">;
	private readonly contentIndexes = new Map<number, number>();
	private readonly partialJson = new Map<number, string>();
	private readonly intents: ToolCall[] = [];
	// Calls whose toolcall_end went out, i.e. admitted. Every other tool block in
	// output.content is only a preview of the model's intent and must be withdrawn
	// before the message settles (see withdrawUnadmitted).
	private readonly admittedCalls = new Set<ToolCall>();
	// Previews shown again at the start of a continued turn for calls the bridge has not admitted
	// yet (see carryPreviews). Like every preview they leave the message through withdrawUnadmitted
	// (admit, finish, fail); dropCarried is only a narrower, earlier withdrawal.
	private carried: ToolCall[] = [];
	private ignoredNativeInMessage = 0;
	private nativeOnlyMessages = 0;
	lastIgnoredNativeName = "";
	trailerPending = false;
	started = false;
	finished = false;

	constructor(
		private readonly stream: AssistantMessageEventStream,
		model: Model<Api>,
	) {
		this.output = createOutput(model);
	}

	handle(event: CliEvent): void {
		if (this.finished) return;

		switch (event.type) {
			case "messageStart":
				// Defence: the process fails a message that starts while calls are unadmitted
				// (handleLine), so this normally sees nothing carried.
				this.dropCarried();
				this.ignoredNativeInMessage = 0;
				this.updateUsage(event.usage);
				this.start();
				return;

			case "blockStart":
				this.startBlock(event.index, event.block);
				return;

			case "textDelta": {
				const found = this.getBlock(event.index);
				if (!found) return;

				const { contentIndex, block } = found;
				if (block.type !== "text") return;

				block.text += event.text;
				this.stream.push({ type: "text_delta", contentIndex, delta: event.text, partial: this.output });
				return;
			}

			case "thinkingDelta": {
				const found = this.getBlock(event.index);
				if (!found) return;

				const { contentIndex, block } = found;
				if (block.type !== "thinking") return;

				block.thinking += event.thinking;
				this.stream.push({ type: "thinking_delta", contentIndex, delta: event.thinking, partial: this.output });
				return;
			}

			case "toolInputDelta": {
				const found = this.getBlock(event.index);
				if (!found) return;

				const { contentIndex, block } = found;
				if (block.type !== "toolCall") return;

				const partialJson = (this.partialJson.get(event.index) ?? "") + event.partialJson;
				this.partialJson.set(event.index, partialJson);
				block.arguments = parseStreamingJson(partialJson);
				this.stream.push({ type: "toolcall_delta", contentIndex, delta: event.partialJson, partial: this.output });
				return;
			}

			case "blockStop":
				this.stopBlock(event.index);
				return;

			case "messageDelta":
				this.updateUsage(event.usage);
				if (event.stopReason) this.setStopReason(event.stopReason);
				return;

			case "messageStop":
				// Tool intent is not execution admission. The process publishes only
				// calls that actually reach the authenticated MCP bridge.
				// A finished response is held for its trailer (see TRAILER_GRACE_MS): finishPending() ends it.
				if (this.output.stopReason !== "toolUse") this.trailerPending = true;
				return;

			case "assistantError":
				this.fail(getAssistantErrorMessage(event.error, event.text, this.output.cliRateLimit), "error");
				return;

			case "resultError":
				this.fail(cliErrorMessage(event.text, "claude-code", { rateLimit: this.output.cliRateLimit }), "error");
				return;
		}
	}

	get waitingForAdmission(): boolean { return !this.finished && this.output.stopReason === "toolUse"; }

	getIntents(): ToolCall[] { return this.intents; }

	/**
	 * A message whose only tool calls were native ones the app ignored ends the
	 * model's step, not the turn: the CLI answers each with an error result and
	 * the model continues in a new message that this turn keeps collecting.
	 */
	resumeAfterIgnoredNative(): "resumed" | "limit" | "none" {
		if (!this.waitingForAdmission || this.intents.length > 0 || this.ignoredNativeInMessage === 0) return "none";
		if (++this.nativeOnlyMessages > MAX_NATIVE_ONLY_MESSAGES) return "limit";
		// A bridge preview that never completed cannot be admitted; the next message restarts block indexes.
		this.withdrawUnadmitted(() => false);
		this.contentIndexes.clear();
		this.partialJson.clear();
		this.output.stopReason = "pending";
		return "resumed";
	}

	getMessage(): AssistantMessage { return this.output; }

	getRateLimit(): RateLimitInfo | undefined { return this.output.cliRateLimit; }

	setContextWindow(tokens: number | undefined): void {
		if (!this.finished && tokens !== undefined) this.output.cliContextWindow = tokens;
	}

	/** Ends the wait for the trailer: the held response completes (or fails) as message_stop would have. */
	finishPending(): void {
		if (!this.trailerPending) return;
		this.trailerPending = false;
		if (!this.finished) this.finish();
	}

	/**
	 * The CLI runs MCP tools one at a time, so a batch reaches the bridge call by call: message 1
	 * admits the first and drops the others' previews (pi would execute whatever it carries), and
	 * the CLI asks for the next only once pi has returned the first's result. Showing the preview
	 * again at the start of the continued turn, rather than at that call's admission, keeps the card
	 * on screen through the CLI's round trip instead of blinking out and back. It is a preview like
	 * any other: only an authenticated MCP call (admit) makes it real, and anything else withdraws it
	 * (the CLI starting a message, a cancelled call, the turn ending, a failure).
	 */
	carryPreviews(calls: ToolCall[]): void {
		if (this.finished) return;
		const fresh = calls.filter((call) => !this.output.content.includes(call));
		if (fresh.length === 0) return;
		this.start();
		for (const call of fresh) {
			const contentIndex = this.output.content.length;
			this.output.content.push(call);
			this.carried.push(call);
			this.stream.push({ type: "toolcall_start", contentIndex, partial: this.output });
		}
	}

	/**
	 * Withdraws carried previews (all, or the one with `id`) ahead of the turn's own settling. A defence
	 * rather than the safety mechanism: the safety is that only admit() emits toolcall_end and
	 * admit/finish/fail withdraw every other preview. Only called before this turn streams a block of
	 * its own, so no content index shifts under it.
	 */
	private dropCarried(id?: string): void {
		const dropped = this.carried.filter((call) => id === undefined || call.id === id);
		if (dropped.length === 0) return;
		this.carried = this.carried.filter((call) => !dropped.includes(call));
		this.withdrawUnadmitted((block) => !dropped.includes(block));
	}

	setRateLimit(info: RateLimitInfo): void {
		if (!this.finished) this.output.cliRateLimit = info;
	}

	setResolvedModel(model: string | undefined): void {
		if (!this.finished && model !== undefined) this.output.cliResolvedModel = model;
	}

	/**
	 * Admission is the only thing that ends a tool call. The admitted calls were
	 * normally previewed in this message already (toolcall_start/delta), so they
	 * only get their toolcall_end; a call from an earlier message of the same
	 * response (a parallel batch admitted piecemeal) is started and ended here.
	 * Previews that are not being admitted are withdrawn first.
	 */
	admit(calls: ToolCall[]): void {
		this.start();
		this.carried = [];
		this.withdrawUnadmitted((block) => calls.includes(block));
		for (const call of calls) {
			let contentIndex = this.output.content.indexOf(call);
			if (contentIndex === -1) {
				contentIndex = this.output.content.length;
				this.output.content.push(call);
				this.stream.push({ type: "toolcall_start", contentIndex, partial: this.output });
			}
			this.admittedCalls.add(call);
			this.stream.push({ type: "toolcall_end", contentIndex, toolCall: call, partial: this.output });
		}
		this.output.stopReason = "toolUse";
		this.finish();
	}

	/** A cancelled call must not stay on screen as a card that can never run. */
	withdraw(id: string): void {
		if (this.finished) return;
		this.dropCarried(id);
		if (this.output.stopReason !== "toolUse") return;
		this.withdrawUnadmitted((block) => block.id !== id);
	}

	fail(message: string, reason: "aborted" | "error"): void {
		if (this.finished) return;

		// Nothing was admitted, so no streamed preview may survive into the final message as a phantom card.
		this.withdrawUnadmitted(() => false);
		this.finished = true;
		this.output.stopReason = reason;
		this.output.errorMessage = message;
		this.stream.push({ type: "error", reason, error: this.output });
		this.stream.end();
	}

	/** Removes streamed tool-call previews that are not admitted and not wanted by `keep`. */
	private withdrawUnadmitted(keep: (block: ToolCall) => boolean): void {
		const kept = this.output.content.filter((block) => block.type !== "toolCall" || this.admittedCalls.has(block) || keep(block));
		if (kept.length === this.output.content.length) return;
		this.output.content.splice(0, this.output.content.length, ...kept);
	}

	private start(): void {
		if (this.started) return;

		this.started = true;
		this.stream.push({ type: "start", partial: this.output });
	}

	private startBlock(index: number, block: CliBlock): void {
		const contentIndex = this.output.content.length;

		switch (block.type) {
			case "text":
				this.contentIndexes.set(index, contentIndex);
				this.output.content.push({ type: "text", text: "" });
				this.stream.push({ type: "text_start", contentIndex, partial: this.output });
				return;

			case "thinking":
				this.contentIndexes.set(index, contentIndex);
				this.output.content.push({ type: "thinking", thinking: "" });
				this.stream.push({ type: "thinking_start", contentIndex, partial: this.output });
				return;

			case "toolUse":
				// A tool the app never offered (a user plugin, a native CLI tool) is not
				// admitted, executed or shown. The CLI answers it with an error result
				// and the model carries on; its deltas find no block and fall away.
				if (!isBridgeToolName(block.name)) {
					console.warn("claude CLI native tool call ignored:", block.name);
					this.ignoredNativeInMessage++;
					this.lastIgnoredNativeName = block.name;
					return;
				}
				// Shown while it streams, like the API provider; only admission (toolcall_end) makes it real.
				this.contentIndexes.set(index, contentIndex);
				this.output.content.push({ type: "toolCall", id: block.id, name: toolNameFromMcp(block.name), arguments: {} });
				this.stream.push({ type: "toolcall_start", contentIndex, partial: this.output });
				return;
		}
	}

	private getBlock(index: number): { contentIndex: number; block: AssistantMessage["content"][number] } | null {
		const contentIndex = this.contentIndexes.get(index);
		if (contentIndex === undefined) return null;

		const block = this.output.content[contentIndex];
		return block ? { contentIndex, block } : null;
	}

	private stopBlock(index: number): void {
		const found = this.getBlock(index);
		if (!found) return;

		const { contentIndex, block } = found;
		this.contentIndexes.delete(index);

		switch (block.type) {
			case "text":
				this.stream.push({ type: "text_end", contentIndex, content: block.text, partial: this.output });
				return;

			case "thinking":
				this.stream.push({ type: "thinking_end", contentIndex, content: block.thinking, partial: this.output });
				return;

			case "toolCall":
				Object.assign(block, parseToolCallArguments(this.partialJson.get(index) ?? ""));
				this.partialJson.delete(index);
				this.intents.push(block);
				return;
		}
	}

	private updateUsage(usage: CliUsage): void {
		Object.assign(this.output.usage, usage);

		const { input, output, cacheRead, cacheWrite } = this.output.usage;
		this.output.usage.totalTokens = input + output + cacheRead + cacheWrite;
	}

	private setStopReason(stopReason: string): void {
		const mapped = STOP_REASONS[stopReason];

		if (!mapped) {
			this.output.stopReason = "error";
			this.output.errorMessage = `Unhandled stop reason: ${stopReason}`;
			return;
		}

		this.output.stopReason = mapped;
	}

	private finish(): void {
		const { stopReason } = this.output;

		if (stopReason === "error") {
			this.fail(this.output.errorMessage ?? REFUSAL_MESSAGE, "error");
			return;
		}

		if (stopReason === "pending" || stopReason === "aborted") {
			this.fail(this.output.errorMessage ?? NO_STOP_REASON_MESSAGE, "error");
			return;
		}

		// A finished answer admitted nothing, and pi-agent-core runs the tool calls of any final message
		// that is not an error, abort or cut-off: no streamed preview may ride it.
		if (stopReason === "stop") this.withdrawUnadmitted(() => false);
		this.finished = true;
		this.stream.push({ type: "done", reason: stopReason, message: this.output });
		this.stream.end();
	}
}

type TurnFiles = { cwd: string; privateDir: string; systemPromptFile: string; mcpConfigFile: string };

async function createTurnFiles(systemPrompt: string, mcpConfig: string): Promise<TurnFiles> {
	const cwd = await mkdtemp(join(tmpdir(), "claude-code-cwd-"));
	let privateDir: string | undefined;
	try {
		privateDir = await mkdtemp(join(tmpdir(), "claude-code-private-"));
		const systemPromptFile = join(privateDir, "system-prompt.md");
		const mcpConfigFile = join(privateDir, "mcp.json");
		await writeFile(systemPromptFile, systemPrompt, { mode: PRIVATE_FILE_MODE });
		await writeFile(mcpConfigFile, mcpConfig, { mode: PRIVATE_FILE_MODE });
		return { cwd, privateDir, systemPromptFile, mcpConfigFile };
	} catch (error) {
		await Promise.all([rm(cwd, { recursive: true, force: true }), ...(privateDir ? [rm(privateDir, { recursive: true, force: true })] : [])]);
		throw error;
	}
}

async function removeTurnResources(bridge: ToolBridge, files: TurnFiles): Promise<void> {
	await Promise.all([
		bridge.close(),
		rm(files.cwd, { recursive: true, force: true }),
		rm(files.privateDir, { recursive: true, force: true }),
	]);
}

/**
 * A CLI process and the turns it serves; one process can serve a whole lesson (forest spec C).
 *
 *   streaming ──admitted tool calls, with a session──▶ awaitingResults ──matching tool results──▶ streaming
 *   streaming ──done(stop), with a session──▶ idle ──the held lesson plus new user messages──▶ streaming
 *   any phase ──failure, abort, mismatch, timeout, eviction, output while idle, shutdown──▶ stopped
 *
 * streaming: stdout feeds this.turn. awaitingResults: held MCP calls wait for pi's tool results
 * (registered). idle: the turn is over and stdin stays open for the lesson's next message
 * (registered); anything the CLI does on its own while idle ends it. stopped (stopping/closed) is
 * never reused; a failure after an admitted slice is still reported once, to that slice's
 * continuation (pendingError). `conversation` is the model-visible lesson the CLI holds, in
 * conversationForReuse form, so a continuation is only taken when the history plainly extends it.
 */
type Phase = "streaming" | "awaitingResults" | "idle";

class ClaudeProcess implements LiveProcess {
	toolCallIds: string[] = [];
	private phase: Phase = "streaming";
	private stderr = "";
	private closed = false;
	private stopping = false;
	private killTimer: NodeJS.Timeout | undefined;
	private trailerTimer: NodeJS.Timeout | undefined;
	private signal: AbortSignal | undefined;
	private sourceCalls: ToolCall[] = [];
	private sourceComplete = false;
	private admitted: PendingToolCall[] = [];
	private readonly cancelledIds = new Set<string>();
	private readonly ignoredNativeCalls = new Map<string, string>();
	private pendingError: string | undefined;
	// The CLI auto-compacted the lesson it holds: never kept idle again.
	private compacted = false;
	private contextWindow: number | undefined;
	private resolvedModel: string | undefined;
	private contextProbe: ContextWindowProbe | undefined;
	// A turn continued from idle that the process never answered (it exited before any output)
	// replays on a fresh process instead of failing: nothing was shown or admitted yet.
	private replayIfLost: (() => void) | undefined;
	// The live-process generation this turn started under: the app moving lessons off the CLI bumps
	// it, and a process from before the bump is ended instead of registered (see isStale).
	private generation = liveGeneration();

	constructor(
		private readonly child: ChildProcessWithoutNullStreams,
		private readonly bridge: ToolBridge,
		private readonly files: TurnFiles,
		private turn: ClaudeTurn,
		readonly owner: symbol,
		readonly sessionId: string | undefined,
		private readonly configuration: unknown,
		private conversation: unknown[],
	) {}

	get isIdle(): boolean { return this.phase === "idle"; }

	private get isStale(): boolean { return this.generation !== liveGeneration(); }

	start(stdinLine: string, signal: AbortSignal | undefined): void {
		this.child.once("close", (code: number | null) => this.handleClose(`claude CLI exited with code ${code}`));
		this.child.once("error", (error) => {
			console.error("claude CLI process failed:", error);
			if (!this.lostBeforeOutput()) this.turn.fail(START_FAILED_MESSAGE, "error");
			this.handleClose(START_FAILED_MESSAGE);
		});
		this.child.stderr.setEncoding("utf8");
		this.child.stderr.on("data", (chunk: string) => { this.stderr = (this.stderr + chunk).slice(-65_536); });
		this.child.stdin.on("error", (error) => console.error("claude CLI stdin closed early:", error));
		this.contextProbe = new ContextWindowProbe(
			(line) => this.child.stdin.write(`${line}\n`),
			() => { if (!this.stopping) this.child.stdin.write(`${stdinLine}\n`); },
			(tokens) => { this.contextWindow = tokens; this.turn.setContextWindow(tokens); },
		);
		createInterface({ input: this.child.stdout }).on("line", (line) => {
			try { this.handleLine(line); }
			catch { this.fail("claude CLI emitted malformed stream output"); }
		});
		this.setSignal(signal);
		if (!this.stopping) this.contextProbe.start();
	}

	canContinue(owner: symbol, sessionId: string | undefined, configuration: unknown, messages: Message[], results: ToolResultMessage[]): boolean {
		const conversation = conversationForReuse(messages);
		return this.phase === "awaitingResults" && !this.stopping && owner === this.owner && !!sessionId && sessionId === this.sessionId
			&& isDeepStrictEqual(configuration, this.configuration)
			&& isDeepStrictEqual(conversation.slice(0, this.conversation.length), this.conversation)
			&& conversation.length === this.conversation.length + this.admitted.length
			&& results.length === this.admitted.length
			&& new Set(results.map((result) => result.toolCallId)).size === results.length
			&& this.admitted.every((call) => results.some((result) => result.toolCallId === call.id && result.toolName === call.name));
	}

	continueTurn(turn: ClaudeTurn, messages: Message[], results: ToolResultMessage[], signal: AbortSignal | undefined): void {
		removeLiveProcess(this);
		const admitted = this.admitted;
		this.admitted = [];
		this.conversation = structuredClone(conversationForReuse(messages));
		this.phase = "streaming";
		this.replayIfLost = undefined;
		this.beginTurn(turn);
		this.sourceComplete = this.sourceCalls.length > 0;
		this.setSignal(signal);
		if (this.stopping) return;
		// The calls still waiting for their MCP request show from the first moment of this turn.
		this.turn.carryPreviews(this.sourceCalls);
		for (const call of admitted) {
			const result = results.find((candidate) => candidate.toolCallId === call.id)!;
			this.bridge.resolveToolCall(call, result);
		}
		this.flushAdmissions();
	}

	/**
	 * The new learner messages when `messages` is exactly the lesson this idle process holds plus
	 * user messages after it, under the same configuration; null for anything else (an edited,
	 * retried or compacted history, a changed setting, a tool result, nothing new).
	 */
	continuationOf(owner: symbol, sessionId: string | undefined, configuration: unknown, messages: Message[]): UserMessage[] | null {
		if (this.phase !== "idle" || this.stopping || this.closed) return null;
		if (owner !== this.owner || !sessionId || sessionId !== this.sessionId) return null;
		if (!isDeepStrictEqual(configuration, this.configuration)) return null;
		const visible = messages.filter((message) => message.role !== "system");
		const conversation = conversationForReuse(visible);
		if (conversation.length <= this.conversation.length) return null;
		if (!isDeepStrictEqual(conversation.slice(0, this.conversation.length), this.conversation)) return null;
		const added = visible.slice(this.conversation.length);
		return added.every((message): message is UserMessage => message.role === "user") ? added : null;
	}

	/** Writes the new learner messages to the idle process; its answer streams into `turn`. */
	continueWithMessages(turn: ClaudeTurn, messages: Message[], added: UserMessage[], signal: AbortSignal | undefined, replayIfLost: () => void): void {
		removeLiveProcess(this);
		this.conversation = structuredClone(conversationForReuse(messages));
		this.phase = "streaming";
		this.beginTurn(turn);
		// Per-turn state starts clean; a turn's own counters (native-only messages) live on the turn.
		this.sourceCalls = [];
		this.sourceComplete = false;
		this.admitted = [];
		this.toolCallIds = [];
		this.cancelledIds.clear();
		this.ignoredNativeCalls.clear();
		this.replayIfLost = replayIfLost;
		this.setSignal(signal);
		if (this.stopping) return;
		this.child.stdin.write(`${toStreamJsonLine(toContinuationContent(added))}\n`);
	}

	kill(): void {
		removeLiveProcess(this);
		clearTimeout(this.trailerTimer);
		this.trailerTimer = undefined;
		if (this.stopping || this.closed) return;
		this.stopping = true;
		this.contextProbe?.close();
		this.child.kill();
		this.killTimer = setTimeout(() => this.child.kill("SIGKILL"), 1000);
		this.killTimer.unref();
	}

	fail(message: string): void {
		// A parallel request can fail after the admitted slice was handed to
		// Pi. Retain that failure for its continuation instead of silently
		// replaying and hiding the compatibility error.
		if (this.sessionId && this.phase === "awaitingResults" && this.turn.finished && this.toolCallIds.length > 0) this.pendingError = message;
		this.turn.fail(message, "error");
		this.kill();
		if (this.pendingError && !this.isStale) addLiveProcess(this);
	}

	consumeFailure(owner: symbol, turn: ClaudeTurn): boolean {
		if (owner !== this.owner || !this.pendingError) return false;
		const message = this.pendingError;
		this.pendingError = undefined;
		this.kill();
		turn.fail(message, "error");
		return true;
	}

	cancelCall(call: PendingToolCall): void {
		this.cancelledIds.add(call.id);
		// Already admitted work belongs to Pi and cannot be undone. A queued
		// request, however, must never become executable after cancellation.
		this.sourceCalls = this.sourceCalls.filter((intent) => intent.id !== call.id);
		this.turn.withdraw(call.id);
	}

	/** An authenticated MCP request reached the bridge. */
	handleMcpCall(): void {
		if (this.phase === "idle") {
			// No turn asked for anything: a request now belongs to no streamed intent and never runs.
			console.warn("claude CLI made a tool call while idle; ending it");
			this.kill();
			return;
		}
		this.flushAdmissions();
	}

	/** Only authenticated MCP requests, never stdout intent alone, admit side effects. */
	flushAdmissions(): void {
		if (this.phase !== "streaming" || this.stopping || this.turn.finished || !this.sourceComplete) return;
		const pending = this.bridge.getPendingToolCalls();
		if (pending.length === 0) return;
		const calls: ToolCall[] = [];
		for (const call of pending) {
			const intent = this.sourceCalls.find((candidate) => candidate.id === call.id);
			if (!intent || intent.name !== call.name || !isDeepStrictEqual(intent.arguments, call.arguments)) {
				this.fail("claude CLI compatibility error: MCP call does not match its streamed tool intent");
				return;
			}
			calls.push(intent);
		}
		this.sourceCalls = this.sourceCalls.filter((call) => !pending.some((admitted) => admitted.id === call.id));
		this.admitted = pending;
		this.toolCallIds = pending.map((call) => call.id);
		this.turn.admit(calls);
		this.conversation.push(...structuredClone(conversationForReuse([this.turn.getMessage()])));
		if (this.sessionId && !this.isStale) {
			this.phase = "awaitingResults";
			addLiveProcess(this);
		} else this.kill(); // No trusted scope, or lessons moved off the CLI meanwhile: return the batch, then use fresh replay.
	}

	private readonly abort = () => {
		this.turn.fail(ABORT_MESSAGE, "aborted");
		this.kill();
	};

	private setSignal(signal: AbortSignal | undefined): void {
		this.signal?.removeEventListener("abort", this.abort);
		this.signal = signal;
		signal?.addEventListener("abort", this.abort, { once: true });
		if (signal?.aborted) this.abort();
	}

	private beginTurn(turn: ClaudeTurn): void {
		this.turn = turn;
		this.generation = liveGeneration();
		this.turn.setContextWindow(this.contextWindow);
		// The CLI reports init once per process: every later turn carries the model it resolved.
		this.turn.setResolvedModel(this.resolvedModel);
	}

	private handleLine(line: string): void {
		if (this.stopping || !line.trim()) return;
		if (this.contextProbe?.handle(JSON.parse(line))) return;
		const event = parseCliLine(line);
		if (this.turn.trailerPending) {
			// The line after a finished response's message_stop ends the wait for its trailer. A
			// rate-limit report is that trailer and rides the response. Any other line is handled
			// below, in whatever state the release left, so nothing after the response is swallowed.
			if (event?.type === "rateLimit") this.turn.setRateLimit(event.info);
			this.releaseTrailer();
			if (event?.type === "rateLimit" || this.stopping) return;
		}
		if (!event) return;
		if (event.type === "init") {
			// Once per process, before any response: remember it for this turn and
			// for the continuation turns that reuse the process.
			this.resolvedModel = event.model;
			this.turn.setResolvedModel(event.model);
			return;
		}
		if (event.type === "rateLimit") {
			// The plan-limit report rides the response; it never ends or alters the turn.
			this.turn.setRateLimit(event.info);
			return;
		}
		if (event.type === "compacted") {
			// The CLI rewrote the lesson it holds, so `conversation` no longer describes it. The turn
			// in flight carries on; the process is never kept for the next message (settle kills it).
			this.compacted = true;
			if (this.phase === "idle") this.kill();
			return;
		}
		if (this.phase === "idle") {
			// The CLI acted without being asked: it no longer holds the lesson the snapshot describes.
			console.warn("claude CLI produced output while idle; ending it:", event.type);
			this.kill();
			return;
		}
		if (event.type === "toolResults") {
			// An error result is the CLI declining a tool the app never offered. A
			// successful one means the CLI ran that native tool itself, outside the app.
			// Fail closed: only an explicit error, or the CLI's own unknown-tool wrapper,
			// counts as declined. The result text is logged so a wrong guess is diagnosable.
			for (const result of event.results) {
				const name = this.ignoredNativeCalls.get(result.id);
				if (name === undefined) continue;
				const preview = result.text.slice(0, NATIVE_RESULT_PREVIEW_CHARS);
				if (result.isError || result.text.startsWith(TOOL_USE_ERROR_PREFIX)) {
					console.warn("claude CLI declined native tool call:", name, preview);
					continue;
				}
				console.warn("claude CLI ran native tool call outside the app:", name, preview);
				this.fail(`claude CLI ran a native tool (${name}) outside the app: ${preview}`);
				return;
			}
			if (event.ids.some((id) => this.sourceCalls.some((call) => call.id === id))) {
				this.fail("claude CLI refused a harness tool call before MCP admission");
			}
			return;
		}
		// Moving on before held calls were answered means the CLI did not
		// honor this tool wait. Never execute further stdout-only intentions.
		if (this.turn.finished) {
			this.fail("claude CLI moved on while harness tool calls were waiting for results");
			return;
		}
		if (event.type === "messageStart" && this.sourceComplete && this.sourceCalls.length > 0) {
			this.fail("claude CLI moved on without admitting its harness tool calls");
			return;
		}
		if (event.type === "messageStart") this.contextProbe?.refresh();
		if (event.type === "blockStart" && event.block.type === "toolUse" && !isBridgeToolName(event.block.name)) this.ignoredNativeCalls.set(event.block.id, event.block.name);
		this.turn.handle(event);
		if (this.turn.finished) { this.settle(); return; }
		if (this.turn.trailerPending) {
			this.trailerTimer ??= setTimeout(() => this.releaseTrailer(), TRAILER_GRACE_MS);
			this.trailerTimer.unref();
			return;
		}
		if (event.type === "messageStop") {
			const resumed = this.turn.resumeAfterIgnoredNative();
			if (resumed === "limit") {
				this.fail(`claude CLI kept calling tools the app does not offer (${this.turn.lastIgnoredNativeName})`);
				return;
			}
			if (resumed === "resumed") return;
		}
		if (event.type === "messageStop" && this.turn.waitingForAdmission) {
			const intents = this.turn.getIntents();
			if (intents.length === 0 || new Set(intents.map((call) => call.id)).size !== intents.length) {
				this.fail("claude CLI emitted an invalid tool batch");
				return;
			}
			this.sourceCalls = intents.filter((call) => !this.cancelledIds.has(call.id));
			this.sourceComplete = true;
			this.flushAdmissions();
		}
	}

	private releaseTrailer(): void {
		clearTimeout(this.trailerTimer);
		this.trailerTimer = undefined;
		this.turn.finishPending();
		this.settle();
	}

	/** A finished streaming turn decides the process's fate: a lesson's normal answer keeps it idle. */
	private settle(): void {
		if (this.phase !== "streaming" || !this.turn.finished) return;
		const message = this.turn.getMessage();
		// Never keep a process in a state the snapshot cannot describe: an error, a cut-off answer,
		// a response that also streamed tool intents, MCP requests nobody admitted, or a conversation
		// the CLI compacted on its own.
		const clean = !this.compacted && message.stopReason === "stop" && this.turn.getIntents().length === 0 && this.bridge.getPendingToolCalls().length === 0;
		if (this.sessionId && !this.stopping && !this.closed && !this.isStale && clean) this.becomeIdle(message);
		else this.kill();
	}

	private becomeIdle(message: AssistantMessage): void {
		this.phase = "idle";
		this.replayIfLost = undefined;
		this.toolCallIds = [];
		this.conversation.push(...structuredClone(conversationForReuse([message])));
		// The finished turn's signal no longer owns the process: a later abort of it ends nothing.
		this.setSignal(undefined);
		addIdleProcess(this);
	}

	/** The process ended or failed to run before a continued turn produced anything. */
	private lostBeforeOutput(): boolean {
		return !!this.replayIfLost && this.phase === "streaming" && !this.turn.started && !this.turn.finished && !this.signal?.aborted;
	}

	private handleClose(message: string): void {
		if (this.closed) return;
		this.closed = true;
		const replay = this.lostBeforeOutput() ? this.replayIfLost : undefined;
		this.replayIfLost = undefined;
		clearTimeout(this.trailerTimer);
		this.turn.finishPending();
		this.contextProbe?.close();
		clearTimeout(this.killTimer);
		// A retained failure stays registered for its continuation; once taken out, it never comes back.
		if (!this.pendingError) removeLiveProcess(this);
		this.signal?.removeEventListener("abort", this.abort);
		if (this.stderr.trim()) console.error("claude CLI stderr:", this.stderr.trim());
		if (replay) {
			console.warn("claude CLI ended before answering a continued message; replaying the lesson on a fresh process");
			replay();
		} else this.turn.fail(cliErrorMessage(message, "claude-code", { rateLimit: this.turn.getRateLimit() }), "error");
		removeTurnResources(this.bridge, this.files).catch((error: unknown) => {
			console.error("claude CLI cleanup failed:", error);
		});
	}
}

function hasSameIds(ids: string[], otherIds: string[]): boolean {
	return ids.length === otherIds.length && new Set(otherIds).size === otherIds.length && ids.every((id) => otherIds.includes(id));
}

/**
 * Hands the turn to the lesson's live process when the history plainly continues what that process
 * holds: tool results for the calls it is waiting on, or new user messages after its finished
 * answer. Anything else kills it and the caller replays the lesson on a fresh process.
 */
function continueLiveProcess(
	turn: ClaudeTurn,
	owner: symbol,
	sessionId: string | undefined,
	configuration: unknown,
	messages: Message[],
	signal: AbortSignal | undefined,
	replay: () => void,
): boolean {
	const process = getLiveProcess(owner, sessionId);
	if (!(process instanceof ClaudeProcess)) return false;

	if (process.isIdle) {
		const added = process.continuationOf(owner, sessionId, configuration, messages);
		if (!added) {
			process.kill();
			return false;
		}
		process.continueWithMessages(turn, messages, added, signal, replay);
		return true;
	}

	const assistantIndex = messages.findLastIndex((message) => message.role === "assistant");
	const assistant = messages[assistantIndex];
	const ids = assistant?.role === "assistant" ? assistant.content.flatMap((block) => block.type === "toolCall" ? [block.id] : []) : [];
	if (ids.length === 0 || !hasSameIds(process.toolCallIds, ids)) {
		process.kill();
		return false;
	}
	if (process.consumeFailure(owner, turn)) return true;
	const trailing = messages.slice(assistantIndex + 1);
	const results = trailing.filter((message) => message.role === "toolResult");
	if (trailing.length !== results.length || !process.canContinue(owner, sessionId, configuration, messages, results)) {
		process.kill();
		return false;
	}
	process.continueTurn(turn, messages, results, signal);
	return true;
}

/** Output cap when the API catalog has no entry for the model. */
const FALLBACK_MAX_OUTPUT_TOKENS = 128_000;
/** Tool-result cap per MCP call; the API path has no such trim, so keep it generous. */
const MAX_MCP_OUTPUT_TOKENS = 50_000;

/** The CLI's own per-reply cap is lower than the API's; hand it the API's number
 *  for the same model family so the two backends cut off at the same place. */
function apiOutputCap(model: Model<Api> | undefined): number {
	const apiId = model ? toApiModelId(model.id) : null;
	const catalog = ANTHROPIC_MODELS as Record<string, { maxTokens: number } | undefined>;
	return (apiId ? catalog[apiId]?.maxTokens : undefined) ?? FALLBACK_MAX_OUTPUT_TOKENS;
}

export function toClaudeEnv(model?: Model<Api>): NodeJS.ProcessEnv {
	// Preserve native CLI auth/routing, including launch-environment credentials.
	// Claude Code chooses the account and billing method, not LearnHarness.
	const env: NodeJS.ProcessEnv = {
		...externalCliEnv(),
		MCP_TOOL_TIMEOUT: String(MCP_TOOL_TIMEOUT_MS),
		CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(apiOutputCap(model)),
		MAX_MCP_OUTPUT_TOKENS: String(MAX_MCP_OUTPUT_TOKENS),
	};
	// This fork bills the signed-in Claude plan, never the API. Windows env names are case-insensitive, so match any casing.
	for (const name of Object.keys(env)) if (name.toUpperCase() === "ANTHROPIC_API_KEY") delete env[name];
	return env;
}

async function startProcess(
	runClaude: RunClaude,
	turn: ClaudeTurn,
	model: Model<Api>,
	context: TranscriptContext,
	options: SimpleStreamOptions | undefined,
	owner: symbol,
	configuration: unknown,
	env: NodeJS.ProcessEnv,
): Promise<void> {
	if (options?.signal?.aborted) { turn.fail(ABORT_MESSAGE, "aborted"); return; }
	const input = toClaudeInput(context.messages);
	let cliProcess: ClaudeProcess | undefined;
	const bridge = await createToolBridge(input.tools, {
		onCall: () => cliProcess?.handleMcpCall(),
		onError: (error) => cliProcess?.fail(error.message),
		onCancel: (call) => cliProcess?.cancelCall(call),
	});
	let files: TurnFiles;
	try {
		files = await createTurnFiles(input.systemPrompt, bridge.mcpConfig);
	} catch (error) {
		await bridge.close();
		throw error;
	}
	if (options?.signal?.aborted) {
		turn.fail(ABORT_MESSAGE, "aborted");
		await removeTurnResources(bridge, files);
		return;
	}

	let child: ChildProcessWithoutNullStreams | null;
	try {
		const args = toClaudeArgs({
			model: model.id,
			effort: toEffort(options?.reasoning),
			systemPromptFile: files.systemPromptFile,
			mcpConfigFile: files.mcpConfigFile,
			allowedTools: bridge.allowedTools,
		});
		child = await runClaude(args, { cwd: files.cwd, env, signal: options?.signal });
	} catch (error) {
		await removeTurnResources(bridge, files);
		throw error;
	}

	if (!child) {
		turn.fail(ClaudeCodeError.CliNotFound, "error");
		await removeTurnResources(bridge, files);
		return;
	}

	cliProcess = new ClaudeProcess(child, bridge, files, turn, owner, options?.sessionId, configuration, structuredClone(conversationForReuse(context.messages)));
	cliProcess.start(toStreamJsonLine(input.userContent), options?.signal);
}

export function createClaudeCodeStreamFunction(runClaude: RunClaude): StreamFunction<Api, SimpleStreamOptions> {
	const owner = Symbol("claude-code stream owner");
	return (model, context, options) => {
		const stream = createAssistantMessageEventStream();
		const turn = new ClaudeTurn(stream, model);

		const env = toClaudeEnv(model);
		// An existing child must not retain stale authentication/routing after env changes.
		const configuration = { request: configurationForReuse(model, context, toEffort(options?.reasoning)), env };
		// Today's path, and the fallback whenever the lesson's live process cannot take the turn.
		const replay = () => {
			startProcess(runClaude, turn, model, context, options, owner, configuration, env).catch((error: unknown) => {
				console.error("claude CLI turn failed:", error);
				turn.fail(options?.signal?.aborted ? ABORT_MESSAGE : error instanceof ClaudeLaunchError ? error.message : START_FAILED_MESSAGE, options?.signal?.aborted ? "aborted" : "error");
			});
		};
		if (!continueLiveProcess(turn, owner, options?.sessionId, configuration, context.messages, options?.signal, replay)) replay();

		return stream;
	};
}

export const streamClaudeCode = createClaudeCodeStreamFunction(createClaudeLauncher());
