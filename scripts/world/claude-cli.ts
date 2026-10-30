/**
 * One headless Claude Code call for the world scripts, on Isaac's Claude
 * subscription (never the API: ANTHROPIC_API_KEY is stripped from the child's
 * environment). Structured output via --json-schema; no tools, no session.
 *
 * Spawned directly with an args ARRAY and no shell, so the --json-schema value
 * and the system-prompt file path survive Windows quoting untouched.
 */

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getClaudeBinary } from "../../src/agent/claude-code/binary.ts";

const TIMEOUT_MS = 20 * 60_000;

/** The child's environment: ours minus ANTHROPIC_API_KEY (any casing — Windows
 *  env names are case-insensitive). */
export function claudeEnv(env: Record<string, string | undefined> = process.env): NodeJS.ProcessEnv {
	const out: Record<string, string | undefined> = { ...env };
	for (const name of Object.keys(out)) if (name.toUpperCase() === "ANTHROPIC_API_KEY") delete out[name];
	return out as NodeJS.ProcessEnv;
}

/** CLAUDE_BIN override, then the app's own lookup, then the npm-global layout
 *  Isaac's old AI Tutor used, then bare "claude" on PATH. */
function claudeBinary(): string {
	if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
	const found = getClaudeBinary();
	if (found) return found;
	if (process.platform === "win32") {
		const npmGlobal = path.join(
			process.env.APPDATA ?? "",
			"npm",
			"node_modules",
			"@anthropic-ai",
			"claude-code",
			"bin",
			"claude.exe",
		);
		if (fs.existsSync(npmGlobal)) return npmGlobal;
	}
	return "claude";
}

interface ClaudeJsonResult {
	is_error?: boolean;
	result?: string;
	subtype?: string;
	structured_output?: unknown;
}

/** Fallback when the CLI answered in prose: the outermost {...} in the text. */
function extractJson(text: string): unknown {
	const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
	const body = fenced?.[1] ?? text;
	const start = body.indexOf("{");
	const end = body.lastIndexOf("}");
	if (start < 0 || end < start) throw new Error("Claude did not return JSON");
	return JSON.parse(body.slice(start, end + 1));
}

export function runClaudeJson<T>(o: {
	model: "opus" | "sonnet";
	systemPrompt: string;
	prompt: string;
	schema: object;
}): Promise<T> {
	const sysFile = path.join(os.tmpdir(), `lh-world-sys-${crypto.randomBytes(6).toString("hex")}.md`);
	fs.writeFileSync(sysFile, o.systemPrompt, "utf-8");
	const args = [
		"-p",
		"--output-format",
		"json",
		"--json-schema",
		JSON.stringify(o.schema),
		"--model",
		o.model,
		"--system-prompt-file",
		sysFile,
		"--safe-mode",
		"--tools",
		"",
		"--no-session-persistence",
	];

	return new Promise<string>((resolve, reject) => {
		const child = spawn(claudeBinary(), args, { cwd: os.tmpdir(), env: claudeEnv(), windowsHide: true });
		let out = "";
		let err = "";
		const timer = setTimeout(() => {
			child.kill();
			reject(new Error(`claude timed out after ${TIMEOUT_MS / 60_000} min`));
		}, TIMEOUT_MS);
		child.stdout.on("data", (d: Buffer) => (out += d));
		child.stderr.on("data", (d: Buffer) => (err += d));
		child.on("error", (e) => {
			clearTimeout(timer);
			reject(new Error(`Could not start the Claude CLI: ${e.message} (set CLAUDE_BIN to claude.exe)`));
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			if (!out.trim()) reject(new Error(`claude exited ${code}: ${err.slice(0, 500)}`));
			else resolve(out);
		});
		child.stdin.end(o.prompt);
	})
		.then((stdout) => {
			const res = JSON.parse(stdout) as ClaudeJsonResult;
			if (res.is_error) throw new Error(res.result || `claude error (${res.subtype ?? "unknown"})`);
			return (res.structured_output ?? extractJson(res.result ?? "")) as T;
		})
		.finally(() => fs.rmSync(sysFile, { force: true }));
}
