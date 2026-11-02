import React from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { KEYBOARD_ACTIONS } from "../src/core/index.ts";
import { Home } from "../components/home.tsx";
import { ServerEventsProvider } from "../components/server-events.tsx";

const router = {
	push() {}, replace() {}, back() {}, forward() {}, refresh() {}, prefetch() {},
} as unknown as React.ContextType<typeof AppRouterContext>;

function render(props: Partial<Parameters<typeof Home>[0]> = {}): Document {
	const html = renderToStaticMarkup(
		React.createElement(
			AppRouterContext.Provider,
			{ value: router },
			React.createElement(
				ServerEventsProvider,
				null,
				React.createElement(Home, { initialConfigured: true, ...props }),
			),
		),
	);
	return parseHTML(`<html><body>${html}</body></html>`).document;
}

function switchLinks(doc: Document) {
	const group = doc.querySelector('[data-testid="home-view-switch"]');
	assert.ok(group, "the view switch renders");
	assert.equal(group.getAttribute("data-slot"), "button-group", "it is the button-group UI");
	return [...group.querySelectorAll("a")].map((a) => ({
		text: a.textContent?.trim(),
		href: a.getAttribute("href"),
		current: a.getAttribute("aria-current"),
	}));
}

describe("Home view switch", () => {
	it("defaults to the forest: Forest is current, both entries are links", () => {
		assert.deepEqual(switchLinks(render()), [
			{ text: "Forest", href: "/", current: "page" },
			{ text: "Graph", href: "/graph", current: null },
		]);
	});

	it('view="graph" marks Graph current', () => {
		assert.deepEqual(switchLinks(render({ view: "graph" })), [
			{ text: "Forest", href: "/", current: null },
			{ text: "Graph", href: "/graph", current: "page" },
		]);
	});

	it("the forest view mounts ForestView (loading notice on the server); the graph view does not", () => {
		const forest = render().querySelector("main");
		const graph = render({ view: "graph" }).querySelector("main");
		assert.ok(forest?.textContent?.includes("Loading…"), "forest mounts ForestView");
		assert.ok(!graph?.textContent?.includes("Loading…"), "graph view has no ForestView");
	});

	it("graph rendering off: the switch is hidden (nothing to switch)", () => {
		assert.ok(!render({ rendering: false }).querySelector('[data-testid="home-view-switch"]'));
	});

	for (const view of ["forest", "graph"] as const) {
		it(`graph rendering off: MinimalHome still renders (view=${view})`, () => {
			const doc = render({ view, rendering: false });
			const main = doc.querySelector("main");
			assert.ok(main?.querySelector('[data-testid="knowledge-summary"]'), "MinimalHome renders");
			assert.ok(!main?.textContent?.includes("Loading…"), "no forest when rendering is off");
		});
	}
});

describe("keyboard: forest and graph jumps", () => {
	it("jump-forest is Mod+Shift+G, jump-graph stays Mod+G", () => {
		const forest = KEYBOARD_ACTIONS.find((a) => a.id === "jump-forest");
		const graph = KEYBOARD_ACTIONS.find((a) => a.id === "jump-graph");
		assert.equal(forest?.binding, "mod+shift+g");
		assert.equal(forest?.label, "Forest view");
		assert.equal(graph?.binding, "mod+g");
		assert.equal(graph?.label, "Graph view");
	});

	it("no two actions share a binding", () => {
		const seen = new Map<string, string>();
		for (const a of KEYBOARD_ACTIONS) {
			if (a.displayOnly) continue;
			assert.ok(!seen.has(a.binding), `${a.id} duplicates ${seen.get(a.binding)}`);
			seen.set(a.binding, a.id);
		}
	});
});
