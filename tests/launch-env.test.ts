/**
 * The Forest launcher's server environment (scripts/launch-env.mjs) and the
 * shared default data folder (scripts/data-dir.mjs). Pure: the exists-check,
 * platform and home folder are injected, nothing touches the real machine.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { defaultDataDir } from "../scripts/data-dir.mjs";
import { claudeExeDir, serverEnv } from "../scripts/launch-env.mjs";

const HOME = "C:\\Users\\someone";
const APPDATA = "C:\\Users\\someone\\AppData\\Roaming";
const EXE_DIR = path.win32.join(APPDATA, "npm", "node_modules", "@anthropic-ai", "claude-code", "bin");

const opts = (exists: (p: string) => boolean) => ({ platform: "win32" as const, homeDir: HOME, exists });

describe("defaultDataDir", () => {
	it("is Documents/learnharness-data under the home folder", () => {
		assert.equal(defaultDataDir(HOME), path.join(HOME, "Documents", "learnharness-data"));
	});
});

describe("serverEnv", () => {
	it("removes ANTHROPIC_API_KEY in any casing", () => {
		const env = serverEnv(
			{ ANTHROPIC_API_KEY: "a", anthropic_api_key: "b", Anthropic_Api_Key: "c", OTHER: "keep", APPDATA },
			opts(() => false),
		);
		assert.ok(!Object.keys(env).some((k) => k.toUpperCase() === "ANTHROPIC_API_KEY"));
		assert.equal(env.OTHER, "keep");
	});

	it("does not mutate the base environment", () => {
		const base = { ANTHROPIC_API_KEY: "a", Path: "C:\\x", APPDATA };
		serverEnv(base, opts(() => true));
		assert.deepEqual(base, { ANTHROPIC_API_KEY: "a", Path: "C:\\x", APPDATA });
	});

	it("sets LH_DATA_DIR to the default when unset or empty, keeps an explicit one", () => {
		const def = defaultDataDir(HOME);
		assert.equal(serverEnv({ APPDATA }, opts(() => false)).LH_DATA_DIR, def);
		assert.equal(serverEnv({ APPDATA, LH_DATA_DIR: "" }, opts(() => false)).LH_DATA_DIR, def);
		assert.equal(serverEnv({ APPDATA, LH_DATA_DIR: "D:\\data" }, opts(() => false)).LH_DATA_DIR, "D:\\data");
	});

	it("runs the server in development mode", () => {
		assert.equal(serverEnv({ APPDATA, NODE_ENV: "test" }, opts(() => false)).NODE_ENV, "development");
	});

	it("prepends the npm-global claude.exe folder to PATH (whatever its casing) when the exe exists", () => {
		const seen: string[] = [];
		const env = serverEnv(
			{ Path: "C:\\Windows;C:\\tools", APPDATA },
			opts((p) => {
				seen.push(p);
				return p === path.win32.join(EXE_DIR, "claude.exe");
			}),
		);
		assert.equal(env.Path, `${EXE_DIR};C:\\Windows;C:\\tools`);
		assert.ok(!("PATH" in env), "no second PATH key next to Path");
		assert.ok(seen.includes(path.win32.join(EXE_DIR, "claude.exe")));
	});

	it("leaves PATH alone when the exe is missing, and does not add it twice", () => {
		assert.equal(serverEnv({ PATH: "C:\\Windows", APPDATA }, opts(() => false)).PATH, "C:\\Windows");
		const twice = serverEnv({ PATH: `${EXE_DIR};C:\\Windows`, APPDATA }, opts(() => true));
		assert.equal(twice.PATH, `${EXE_DIR};C:\\Windows`);
	});

	it("creates PATH when there is none", () => {
		assert.equal(serverEnv({ APPDATA }, opts(() => true)).PATH, EXE_DIR);
	});

	it("finds the exe under APPDATA, falling back to the home folder's AppData\\Roaming", () => {
		assert.equal(claudeExeDir({ APPDATA }, HOME), EXE_DIR);
		assert.equal(claudeExeDir({}, HOME), EXE_DIR);
	});

	it("does nothing to PATH off Windows", () => {
		const env = serverEnv({ PATH: "/usr/bin", APPDATA }, { platform: "linux", homeDir: HOME, exists: () => true });
		assert.equal(env.PATH, "/usr/bin");
	});
});
