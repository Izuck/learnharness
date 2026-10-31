// The environment the launcher (scripts/launch.mjs) gives the app server. Pure: the exists-check,
// platform and home folder are injectable, so tests never look at the real machine.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultDataDir } from "./data-dir.mjs";

/** The folder holding the real claude.exe of an npm-global Claude Code install on Windows. %APPDATA%\npm
 *  itself only has claude/claude.cmd/claude.ps1 shims, which the app's lookup (src/agent/claude-code/
 *  binary.ts, spawned with no shell) rightly refuses.
 *  @param {Record<string, string | undefined>} env
 *  @param {string} homeDir
 *  @returns {string} */
export function claudeExeDir(env, homeDir) {
	const appData = env.APPDATA || path.win32.join(homeDir, "AppData", "Roaming");
	return path.win32.join(appData, "npm", "node_modules", "@anthropic-ai", "claude-code", "bin");
}

/** The server child's env: the base env minus ANTHROPIC_API_KEY in any casing (Windows env names are
 *  case-insensitive; LearnHarness's src/server/keys.ts would treat it as an API key and offer API
 *  models that bill API credits), with LH_DATA_DIR defaulted, NODE_ENV=development, and on Windows the
 *  npm-global claude.exe folder prepended to PATH when that exe exists. The base env is not mutated.
 *  @param {Record<string, string | undefined>} baseEnv
 *  @param {{ platform?: NodeJS.Platform, homeDir?: string, exists?: (p: string) => boolean }} [o]
 *  @returns {Record<string, string | undefined>} */
export function serverEnv(baseEnv, o = {}) {
	const platform = o.platform ?? process.platform;
	const homeDir = o.homeDir ?? os.homedir();
	const exists = o.exists ?? fs.existsSync;

	/** @type {Record<string, string | undefined>} */
	const env = { ...baseEnv };
	for (const name of Object.keys(env)) if (name.toUpperCase() === "ANTHROPIC_API_KEY") delete env[name];
	env.LH_DATA_DIR = baseEnv.LH_DATA_DIR || defaultDataDir(homeDir);
	env.NODE_ENV = "development";

	if (platform === "win32") {
		const dir = claudeExeDir(baseEnv, homeDir);
		if (exists(path.win32.join(dir, "claude.exe"))) {
			// Reuse the existing key's spelling (usually "Path"); a second "PATH" key would be ambiguous.
			const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
			const parts = (env[key] ?? "").split(";").filter(Boolean);
			const has = parts.some((p) => path.win32.resolve(p).toLowerCase() === dir.toLowerCase());
			if (!has) env[key] = [dir, ...parts].join(";");
		}
	}
	return env;
}
