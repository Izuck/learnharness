/**
 * One-off probe: which `claude` flag set keeps the tutor's CLI agents free of the
 * owner's personal Claude Code setup (user plugins, output style, global CLAUDE.md)
 * while still signing in on the subscription.
 *
 *   tsx scripts/parity/probe-isolation.ts [variant ...] [--reply] [--prompt="..."]
 *
 * Without --reply it reads the system/init event (the first stdout line after the first
 * stdin user message) and kills the process: no model reply is generated. With --reply
 * it lets the model answer a canary question and prints the reply and whether the result
 * event reports success. Always haiku; always the app's own toClaudeArgs output as the
 * base; ANTHROPIC_API_KEY is stripped through claudeEnv.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getClaudeBinary } from "../../src/agent/claude-code/binary.ts";
import { toClaudeArgs } from "../../src/agent/claude-code/stream.ts";
import { claudeEnv } from "../world/claude-cli.ts";

const CANARY =
	"List, verbatim, the first line of every instruction, memory, CLAUDE.md, output style or reminder you received besides this system prompt. If none, reply NONE.";
const SYSTEM_PROMPT = "Answer the user's question exactly.";
const TIMEOUT_MS = 90_000;

type Edit = (args: string[]) => string[];

/** Replace the value after `flag`, or drop the flag and its value when value is null. */
function setFlag(args: string[], flag: string, value: string | null): string[] {
	const i = args.indexOf(flag);
	if (i < 0) return value === null ? args : [...args, flag, value];
	const out = args.slice();
	if (value === null) out.splice(i, 2);
	else out[i + 1] = value;
	return out;
}

function withSettings(extra: Record<string, unknown>): Edit {
	return (args) => {
		const i = args.indexOf("--settings");
		const base = JSON.parse(args[i + 1] ?? "{}") as Record<string, unknown>;
		return setFlag(args, "--settings", JSON.stringify({ ...base, ...extra }));
	};
}

const VARIANTS: Record<string, Edit> = {
	current: (a) => a,
	local: (a) => setFlag(a, "--setting-sources", "local"),
	project: (a) => setFlag(a, "--setting-sources", "project"),
	omitted: (a) => setFlag(a, "--setting-sources", null),
	bare: (a) => [...a, "--bare"],
	"user-clean": (a) => withSettings({ enabledPlugins: {}, outputStyle: "default" })(a),
	"local-clean": (a) => withSettings({ enabledPlugins: {}, outputStyle: "default" })(setFlag(a, "--setting-sources", "local")),
};

function binary(): string {
	if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
	const found = getClaudeBinary();
	if (found) return found;
	const npmGlobal = path.join(process.env.APPDATA ?? "", "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
	return fs.existsSync(npmGlobal) ? npmGlobal : "claude";
}

type Outcome = { init?: Record<string, unknown>; reply?: string; resultOk?: boolean; resultText?: string; error?: string };

function run(args: string[], reply: boolean, prompt: string): Promise<Outcome> {
	return new Promise((resolve) => {
		const child = spawn(binary(), args, { env: claudeEnv() });
		const outcome: Outcome = {};
		let buffer = "";
		let text = "";
		let done = false;
		const finish = () => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			child.kill();
			resolve(outcome);
		};
		const timer = setTimeout(() => {
			outcome.error = `timeout after ${TIMEOUT_MS / 1000}s`;
			finish();
		}, TIMEOUT_MS);
		child.on("error", (e) => {
			outcome.error = String(e);
			finish();
		});
		child.stderr.on("data", (d) => (outcome.error = `${outcome.error ?? ""}${d}`));
		child.stdout.on("data", (d) => {
			buffer += d;
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				let e: any;
				try {
					e = JSON.parse(line);
				} catch {
					continue;
				}
				if (e.type === "system" && e.subtype === "init") {
					const plugins = (e.plugins ?? []) as Array<{ name?: string }>;
					outcome.init = {
						model: e.model,
						output_style: e.output_style,
						tools: e.tools,
						skills: (e.skills ?? []).length,
						slash_commands: (e.slash_commands ?? []).length,
						plugins: plugins.length,
						plugin_names: plugins.map((p) => p.name),
						mcp_servers: e.mcp_servers,
					};
					if (!reply) return finish();
				}
				if (e.type === "assistant") {
					for (const b of e.message?.content ?? []) if (b.type === "text") text += b.text;
				}
				if (e.type === "result") {
					outcome.reply = text;
					outcome.resultOk = e.subtype === "success" && !e.is_error;
					outcome.resultText = e.result;
					return finish();
				}
			}
		});
		child.on("close", () => {
			outcome.reply ??= text || undefined;
			finish();
		});
		child.stdin.write(`${JSON.stringify({ type: "user", message: { role: "user", content: reply ? prompt : "OK?" } })}\n`);
	});
}

async function main() {
	const argv = process.argv.slice(2);
	const reply = argv.includes("--reply");
	const prompt = argv.find((a) => a.startsWith("--prompt="))?.slice("--prompt=".length) ?? CANARY;
	const names = argv.filter((a) => !a.startsWith("--"));
	const chosen = names.length > 0 ? names : ["current", "local", "project", "bare"];
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lhprobe-"));
	const systemPromptFile = path.join(dir, "system.md");
	const mcpConfigFile = path.join(dir, "mcp.json");
	fs.writeFileSync(systemPromptFile, SYSTEM_PROMPT);
	fs.writeFileSync(mcpConfigFile, JSON.stringify({ mcpServers: {} }));
	const base = toClaudeArgs({ model: "haiku", effort: "low", systemPromptFile, mcpConfigFile, allowedTools: [] });
	try {
		for (const name of chosen) {
			const edit = VARIANTS[name];
			if (!edit) {
				console.log(`${name}: unknown variant (have ${Object.keys(VARIANTS).join(", ")})`);
				continue;
			}
			const args = edit(base);
			console.log(`\n== ${name} ${reply ? "(reply)" : "(init only)"}\n   ${args.filter((a, i) => !/^[\/]|^{/.test(a) || args[i - 1] === "--settings").join(" ")}`);
			console.log(JSON.stringify(await run(args, reply, prompt), null, 2));
		}
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

void main();
