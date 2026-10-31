/**
 * The "Run on: Claude plan / API key" control (forest spec B) in the Agent
 * settings, and the open lesson's one-click switch in the model picker.
 * SSR pins the markup (effects never run under renderToStaticMarkup);
 * the lesson switch is driven through a linkedom DOM like
 * claude-code-context-ui.test.tsx.
 */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { AgentSection } from "../components/settings/agent-section.tsx";
import { BackendSegments } from "../components/settings/backend-switch.tsx";
import { ModelControl } from "../components/model-picker.tsx";
import type { ModelsSettings } from "../src/core/index.ts";

const noop = () => {};
const section = (models: ModelsSettings | undefined) =>
	renderToStaticMarkup(
		<AgentSection agent={undefined} models={models} graph={undefined} compaction={undefined} onSectionChange={noop} onModelsChange={noop} onCompactionChange={noop} />,
	);
function tagOf(html: string, testid: string): string {
	const i = html.indexOf(`data-testid="${testid}"`);
	assert.ok(i >= 0, `${testid} rendered`);
	return html.slice(html.lastIndexOf("<", i), html.indexOf(">", i) + 1);
}
const pin = (provider: string, id: string) => ({ model: { provider, id } });

describe("the Run on control", () => {
	it("renders both options above the slots, nothing selected when no Claude pin exists", () => {
		const html = section(undefined);
		assert.ok(html.includes("Run on"));
		assert.ok(html.includes(">Claude plan<") && html.includes(">API key<"));
		assert.match(tagOf(html, "backend-claude-code"), /aria-checked="false"/);
		assert.match(tagOf(html, "backend-anthropic"), /aria-checked="false"/);
		assert.ok(html.indexOf('data-testid="backend-row"') < html.indexOf('data-testid="slot-row-strong"'), "above the slots");
		assert.ok(!html.includes(">Mixed<"));
	});

	it("selects the backend every Claude pin agrees on", () => {
		const cli = section({ strong: pin("claude-code", "opus"), cheap: pin("claude-code", "haiku") });
		assert.match(tagOf(cli, "backend-claude-code"), /aria-checked="true"/);
		assert.match(tagOf(cli, "backend-anthropic"), /aria-checked="false"/);
		const api = section({ strong: pin("anthropic", "claude-opus-5-5") });
		assert.match(tagOf(api, "backend-anthropic"), /aria-checked="true"/);
		assert.ok(!api.includes(">Mixed<"));
	});

	it("says Mixed, with neither option selected, when slots disagree", () => {
		const html = section({ strong: pin("claude-code", "opus"), cheap: pin("anthropic", "claude-haiku-5-5") });
		assert.match(html, /data-testid="backend-current"[^>]*>Mixed</);
		assert.match(tagOf(html, "backend-claude-code"), /aria-checked="false"/);
		assert.match(tagOf(html, "backend-anthropic"), /aria-checked="false"/);
	});

	it("lists the pins that could not be mapped in a note", () => {
		const html = renderToStaticMarkup(
			<BackendSegments current="anthropic" unmapped={["strong: claude-fable-5-1"]} onSwitch={noop} />,
		);
		assert.match(html, /data-testid="backend-unmapped"[^>]*>[^<]*strong: claude-fable-5-1/);
		assert.ok(!renderToStaticMarkup(<BackendSegments current="anthropic" unmapped={[]} onSwitch={noop} />).includes("backend-unmapped"));
	});
});

// ─── the lesson switch ───────────────────────────────────────────────────────

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
	CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true,
	requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0),
	cancelAnimationFrame: (id: number) => clearTimeout(id),
});
Object.assign(dom.window, { innerWidth: 1280, innerHeight: 800 });
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
const originalFetch = globalThis.fetch;
let root: Root | undefined, host: HTMLDivElement | undefined;
afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); root = undefined; globalThis.fetch = originalFetch; });

describe("the open lesson's switch", () => {
	async function mount(session: { provider: string; id: string }, puts: unknown[]) {
		globalThis.fetch = (async (url, init) => {
			if (url === "/api/models") return Response.json({ models: [], providers: [], slots: { strong: null, cheap: null, vision: null }, defaults: null, rolePins: {} });
			if (url === "/api/settings") return Response.json({ settings: { models: {} } });
			if (url === "/api/chats/lesson-1") return Response.json({ settings: { model: session, thinkingLevel: "high" } });
			if (url === "/api/chats/lesson-1/settings" && init?.method === "PUT") {
				const body = JSON.parse(String(init.body));
				puts.push(body);
				return Response.json({ settings: body });
			}
			throw new Error(`unexpected request ${String(url)}`);
		}) as typeof fetch;
		host = document.createElement("div"); document.body.append(host); root = createRoot(host);
		await act(async () => root!.render(<ModelControl chatId="lesson-1" />));
		await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="stats-model"]')!.click());
	}

	it("offers API key for a Claude plan lesson and writes the mapped model with the same thinking level", async () => {
		const puts: unknown[] = [];
		await mount({ provider: "claude-code", id: "opus" }, puts);
		const button = document.querySelector<HTMLButtonElement>('[data-testid="switch-lesson-backend"]');
		assert.ok(button, "switch offered");
		assert.match(button.textContent ?? "", /Switch this lesson to API key/);
		await act(async () => button.click());
		assert.deepEqual(puts, [{ model: { provider: "anthropic", id: "claude-opus-5-5" }, thinkingLevel: "high" }]);
	});

	it("offers Claude plan for an API lesson", async () => {
		const puts: unknown[] = [];
		await mount({ provider: "anthropic", id: "claude-sonnet-4-5" }, puts);
		const button = document.querySelector<HTMLButtonElement>('[data-testid="switch-lesson-backend"]');
		assert.match(button?.textContent ?? "", /Switch this lesson to Claude plan/);
		await act(async () => button!.click());
		assert.deepEqual(puts, [{ model: { provider: "claude-code", id: "sonnet" }, thinkingLevel: "high" }]);
	});

	it("offers nothing for another provider or an unmappable Claude id", async () => {
		await mount({ provider: "openrouter", id: "z-ai/glm-5.3-flash" }, []);
		assert.equal(document.querySelector('[data-testid="switch-lesson-backend"]'), null);
		await act(async () => root?.unmount()); host?.remove();
		await mount({ provider: "anthropic", id: "claude-fable-5-1" }, []);
		assert.equal(document.querySelector('[data-testid="switch-lesson-backend"]'), null);
	});
});
