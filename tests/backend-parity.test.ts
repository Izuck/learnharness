/**
 * Backend parity (spec B): the pure CLI <-> API model mapping, the
 * whole-record remap, and POST /api/settings/backend (the one switch).
 * The route test writes the repo's data/settings.json (npm test's shared
 * disposable data/) and restores any pre-existing record, like
 * tests/settings-store.test.ts.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { delimiter } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import {
	BACKEND_UNAVAILABLE_REASON,
	CLI_TO_API,
	backendOf,
	currentBackend,
	remapSettings,
	remapSpec,
	toApiModelId,
	toCliModelId,
} from "../src/core/backend-parity.ts";
import type { UserSettings } from "../src/core/settings.ts";

// An empty auth store for this process: the route's availability check reads
// the real key seam, and a developer machine's saved Anthropic key must not
// decide the "no key" refusal. Set before config.ts is evaluated.
const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-backend-auth-"));
process.env.LH_AUTH_FILE = path.join(authDir, "auth.json");
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}");
const { SETTINGS_FILE } = await import("../config.ts");

describe("model id mapping", () => {
	it("round-trips opus, sonnet and haiku both ways", () => {
		assert.deepEqual(CLI_TO_API, {
			opus: "claude-opus-5-5",
			sonnet: "claude-sonnet-5-5",
			haiku: "claude-haiku-5-5",
		});
		for (const cli of ["opus", "sonnet", "haiku"]) {
			const api = toApiModelId(cli);
			assert.ok(api);
			assert.equal(toCliModelId(api), cli);
		}
	});

	it("maps any API id to its family alias; no family is null", () => {
		assert.equal(toCliModelId("claude-opus-4-8"), "opus");
		assert.equal(toCliModelId("claude-sonnet-4-5-20250929"), "sonnet");
		assert.equal(toCliModelId("claude-haiku-4-5"), "haiku");
		assert.equal(toCliModelId("claude-fable-5-1"), null);
		assert.equal(toCliModelId("gpt-5"), null);
		assert.equal(toApiModelId("fable"), null);
	});

	it("backendOf names the two Anthropic providers and nothing else", () => {
		assert.equal(backendOf({ provider: "claude-code" }), "claude-code");
		assert.equal(backendOf({ provider: "anthropic" }), "anthropic");
		assert.equal(backendOf({ provider: "openrouter" }), null);
	});
});

describe("remapSpec", () => {
	it("rewrites provider + id and keeps every other field", () => {
		const out = remapSpec({ provider: "claude-code", id: "opus", thinkingLevel: "high" }, "anthropic");
		assert.deepEqual(out, {
			spec: { provider: "anthropic", id: "claude-opus-5-5", thinkingLevel: "high" },
			changed: true,
			unmapped: false,
		});
		const back = remapSpec(out.spec, "claude-code");
		assert.deepEqual(back.spec, { provider: "claude-code", id: "opus", thinkingLevel: "high" });
	});

	it("is a no-op for a spec already on the target backend", () => {
		const spec = { provider: "anthropic", id: "claude-opus-4-8" };
		assert.deepEqual(remapSpec(spec, "anthropic"), { spec, changed: false, unmapped: false });
	});

	it("leaves other providers untouched and not unmapped", () => {
		const spec = { provider: "openrouter", id: "z-ai/glm-5.3-flash" };
		assert.deepEqual(remapSpec(spec, "claude-code"), { spec, changed: false, unmapped: false });
	});

	it("flags an Anthropic id with no counterpart and keeps it", () => {
		const spec = { provider: "anthropic", id: "claude-fable-5-1" };
		assert.deepEqual(remapSpec(spec, "claude-code"), { spec, changed: false, unmapped: true });
	});
});

describe("remapSettings", () => {
	const record: UserSettings = {
		version: 1,
		general: { autoUpdate: false },
		models: {
			strong: { model: { provider: "claude-code", id: "opus" }, thinkingLevel: "high" },
			cheap: { model: { provider: "claude-code", id: "haiku" } },
			vision: { model: { provider: "openrouter", id: "some/vision" } },
		},
		agent: {
			tools: { research: false },
			models: {
				researcher: { model: { provider: "claude-code", id: "sonnet" }, thinkingLevel: "low" },
				auditor: { thinkingLevel: "medium" },
			},
		},
	};

	it("rewrites the slots and every role override, leaving the rest alone", () => {
		const { record: out, unmapped } = remapSettings(record, "anthropic");
		assert.deepEqual(unmapped, []);
		assert.deepEqual(out.models?.strong, { model: { provider: "anthropic", id: "claude-opus-5-5" }, thinkingLevel: "high" });
		assert.deepEqual(out.models?.cheap, { model: { provider: "anthropic", id: "claude-haiku-5-5" } });
		assert.deepEqual(out.models?.vision, record.models?.vision, "non-Anthropic slot untouched");
		assert.deepEqual(out.agent?.models?.researcher, { model: { provider: "anthropic", id: "claude-sonnet-5-5" }, thinkingLevel: "low" });
		assert.deepEqual(out.agent?.models?.auditor, { thinkingLevel: "medium" });
		assert.deepEqual(out.general, { autoUpdate: false });
		assert.deepEqual(out.agent?.tools, { research: false });
		assert.equal(record.models?.strong?.model?.provider, "claude-code", "input is not mutated");
	});

	it("lists ids it cannot map and leaves those entries as they were", () => {
		const mixed: UserSettings = {
			version: 1,
			models: {
				strong: { model: { provider: "anthropic", id: "claude-fable-5-1" } },
				cheap: { model: { provider: "anthropic", id: "claude-haiku-5-5" } },
			},
			agent: { models: { placer: { model: { provider: "anthropic", id: "claude-fable-5-1" } } } },
		};
		const { record: out, unmapped } = remapSettings(mixed, "claude-code");
		assert.deepEqual(unmapped, ["strong: claude-fable-5-1", "placer: claude-fable-5-1"]);
		assert.equal(out.models?.strong?.model?.id, "claude-fable-5-1");
		assert.equal(out.models?.cheap?.model?.provider, "claude-code");
		assert.equal(out.models?.cheap?.model?.id, "haiku");
	});

	it("handles a record with no models at all", () => {
		const { record: out, unmapped } = remapSettings({ version: 1 }, "anthropic");
		assert.deepEqual(out, { version: 1 });
		assert.deepEqual(unmapped, []);
	});
});

describe("currentBackend", () => {
	const slot = (provider: string, id: string) => ({ model: { provider, id } });
	it("is the shared backend when every Anthropic pin agrees", () => {
		assert.equal(currentBackend({ version: 1, models: { strong: slot("claude-code", "opus"), cheap: slot("claude-code", "haiku"), vision: slot("openrouter", "x") } }), "claude-code");
		assert.equal(currentBackend({ version: 1, models: { strong: slot("anthropic", "claude-opus-5-5") }, agent: { models: { placer: slot("anthropic", "claude-haiku-5-5") } } }), "anthropic");
	});
	it("is mixed when slots or overrides disagree", () => {
		assert.equal(currentBackend({ version: 1, models: { strong: slot("claude-code", "opus"), cheap: slot("anthropic", "claude-haiku-5-5") } }), "mixed");
		assert.equal(currentBackend({ version: 1, models: { strong: slot("claude-code", "opus") }, agent: { models: { placer: slot("anthropic", "claude-haiku-5-5") } } }), "mixed");
	});
	it("votes from role overrides alone, when no slot is pinned", () => {
		assert.equal(currentBackend({ version: 1, agent: { models: { researcher: slot("claude-code", "sonnet") } } }), "claude-code");
		assert.equal(currentBackend({ version: 1, agent: { models: { researcher: slot("claude-code", "sonnet"), placer: slot("anthropic", "claude-haiku-5-5") } } }), "mixed");
		const { record, unmapped } = remapSettings({ version: 1, agent: { models: { researcher: slot("claude-code", "sonnet") } } }, "anthropic");
		assert.deepEqual(unmapped, []);
		assert.equal(record.models, undefined, "no slots are invented");
		assert.deepEqual(record.agent?.models?.researcher, slot("anthropic", "claude-sonnet-5-5"));
	});
	it("is null when no Anthropic pin exists", () => {
		assert.equal(currentBackend({ version: 1 }), null);
		assert.equal(currentBackend({ version: 1, models: { strong: slot("openrouter", "x") } }), null);
	});
});

// ─── the route ───────────────────────────────────────────────────────────────

let hadSettings = false;
let savedSettings = "";
try {
	savedSettings = fs.readFileSync(SETTINGS_FILE, "utf-8");
	hadSettings = true;
} catch {
	/* nothing to snapshot */
}
after(() => {
	fs.rmSync(authDir, { recursive: true, force: true });
	if (hadSettings) fs.writeFileSync(SETTINGS_FILE, savedSettings, "utf-8");
	else fs.rmSync(SETTINGS_FILE, { force: true });
});
afterEach(() => {
	fs.rmSync(SETTINGS_FILE, { force: true });
});

function seed(record: unknown): void {
	fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
	fs.writeFileSync(SETTINGS_FILE, JSON.stringify(record, null, "\t"), "utf-8");
}
const readBack = () => JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf-8")) as UserSettings;

describe("POST /api/settings/backend", () => {
	const KEY_VAR = "ANTHROPIC_API_KEY";
	const savedKey = process.env[KEY_VAR];
	const savedPath = process.env.PATH;
	let binDir = "";
	/** The two backends available: a (never executed) claude binary on PATH,
	 *  CLI opt-in in the seeded record, and an Anthropic key in the env. */
	const available = { claudeCode: { enabled: true } };
	before(() => {
		binDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-backend-bin-"));
		fs.writeFileSync(path.join(binDir, process.platform === "win32" ? "claude.exe" : "claude"), "", { mode: 0o755 });
		process.env.PATH = `${binDir}${delimiter}${savedPath ?? ""}`;
		process.env[KEY_VAR] = "sk-ant-test-fixture";
	});
	after(() => {
		if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath;
		if (savedKey === undefined) delete process.env[KEY_VAR]; else process.env[KEY_VAR] = savedKey;
		fs.rmSync(binDir, { recursive: true, force: true });
	});
	const post = async (body: unknown) => {
		const { POST } = await import("../app/api/settings/backend/route.ts");
		return POST(new Request("http://t/api/settings/backend", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
	};

	it("remaps the stored slots and role overrides through the settings store", async () => {
		seed({
			version: 1,
			...available,
			graph: { enabled: false },
			models: {
				strong: { model: { provider: "claude-code", id: "opus" } },
				cheap: { model: { provider: "claude-code", id: "haiku" } },
			},
			agent: { models: { researcher: { model: { provider: "claude-code", id: "sonnet" } } } },
		});
		const res = await post({ to: "anthropic" });
		assert.equal(res.status, 200);
		const body = (await res.json()) as { unmapped: string[] };
		assert.deepEqual(body.unmapped, []);
		const record = readBack();
		assert.deepEqual(record.models?.strong?.model, { provider: "anthropic", id: "claude-opus-5-5" });
		assert.deepEqual(record.models?.cheap?.model, { provider: "anthropic", id: "claude-haiku-5-5" });
		assert.deepEqual(record.agent?.models?.researcher?.model, { provider: "anthropic", id: "claude-sonnet-5-5" });
		assert.deepEqual(record.graph, { enabled: false });
	});

	it("reports unmapped ids and works with no record at all", async () => {
		seed({ version: 1, ...available, models: { strong: { model: { provider: "anthropic", id: "claude-fable-5-1" } } } });
		const res = await post({ to: "claude-code" });
		assert.deepEqual(((await res.json()) as { unmapped: string[] }).unmapped, ["strong: claude-fable-5-1"]);
		fs.rmSync(SETTINGS_FILE, { force: true });
		assert.equal((await post({ to: "anthropic" })).status, 200);
	});

	it("clamps a pinned thinking level to the new model", async () => {
		seed({ version: 1, ...available, models: { cheap: { model: { provider: "claude-code", id: "opus" }, thinkingLevel: "minimal" } } });
		await post({ to: "anthropic" });
		// API Opus has no "minimal": it lands on the nearest supported level.
		assert.equal(readBack().models?.cheap?.thinkingLevel, "low");
	});

	it("refuses Claude plan with 409 and a plain reason when the CLI is not enabled, leaving the record alone", async () => {
		const before = { version: 1, models: { strong: { model: { provider: "anthropic", id: "claude-opus-5-5" } } } };
		seed(before); // no claudeCode opt-in
		const res = await post({ to: "claude-code" });
		assert.equal(res.status, 409);
		assert.equal(((await res.json()) as { error: string }).error, BACKEND_UNAVAILABLE_REASON["claude-code"]);
		assert.deepEqual(readBack(), before);
	});

	it("refuses API key with 409 and a plain reason when no Anthropic key is saved, leaving the record alone", async (t) => {
		const present = process.env[KEY_VAR];
		delete process.env[KEY_VAR];
		t.after(() => { process.env[KEY_VAR] = present; });
		const before = { version: 1, ...available, models: { strong: { model: { provider: "claude-code", id: "opus" } } } };
		seed(before);
		const res = await post({ to: "anthropic" });
		assert.equal(res.status, 409);
		assert.equal(((await res.json()) as { error: string }).error, BACKEND_UNAVAILABLE_REASON.anthropic);
		assert.deepEqual(readBack(), before);
	});

	it("rejects a bad body", async () => {
		assert.equal((await post({ to: "openrouter" })).status, 400);
		assert.equal((await post(null)).status, 400);
	});
});
