import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import type { ForestModel, ForestSnapshot, ForestTopic, GraphChain, GraphNode } from "../src/core/index.ts";
import { propositionSessionHref } from "../src/core/index.ts";

const dom = parseHTML("<html><body></body></html>");
// A canvas 2D context that accepts everything: property writes are kept,
// method calls and gradient objects are inert.
const noopContext = (): CanvasRenderingContext2D => {
	const store: Record<string | symbol, unknown> = {};
	const callable = () => new Proxy(function () {}, { get: (_t, prop) => (prop === "addColorStop" ? () => {} : undefined), apply: () => undefined });
	return new Proxy(store, {
		get: (target, prop) => (prop in target ? target[prop] : callable()),
		set: (target, prop, value) => { target[prop] = value; return true; },
	}) as unknown as CanvasRenderingContext2D;
};
class TestObserver {
	constructor(readonly callback: () => void) {}
	observe() {}
	disconnect() {}
}
class TestIntersectionObserver {
	observe() {} unobserve() {} disconnect() {}
}
class TestPath2D {
	moveTo() {} lineTo() {} arc() {} rect() {} closePath() {}
}
let fetched: string[] = [];
let snapshot: ForestSnapshot | null = null;
Object.assign(globalThis, {
	window: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement,
	IS_REACT_ACT_ENVIRONMENT: true,
	ResizeObserver: TestObserver,
	IntersectionObserver: TestIntersectionObserver, // next/link prefetch
	self: globalThis,
	Path2D: TestPath2D,
	requestAnimationFrame: () => 1,
	cancelAnimationFrame: () => {},
	getComputedStyle: () => ({ getPropertyValue: () => "", fontFamily: "" }),
	fetch: async (url: string) => {
		fetched.push(String(url));
		return { ok: true, json: async () => snapshot };
	},
});
Object.assign(dom.window, { devicePixelRatio: 1, addEventListener: dom.window.addEventListener.bind(dom.window) });
(dom.window as unknown as { HTMLCanvasElement: typeof HTMLCanvasElement }).HTMLCanvasElement.prototype.getContext = noopContext as never;
Object.assign(globalThis, { HTMLCanvasElement: (dom.window as unknown as { HTMLCanvasElement: unknown }).HTMLCanvasElement });

// Import after installing the DOM globals.
const { ForestView } = await import("../components/forest-view.tsx");
const { ForestIdeaCard } = await import("../components/forest-idea-card.tsx");
const { ServerEventsProvider } = await import("../components/server-events.tsx");

const node = (id: string, name: string, extra: Partial<GraphNode> = {}): GraphNode => ({
	id, name, statement: `${name} statement.`, aliases: [], createdAt: "2026-11-01T00:00:00.000Z", provenance: [], ...extra,
});
const topic = (id: string, ideas: string[] = []): ForestTopic => ({
	id, name: `Topic ${id}`, scope: "", degrees: ["physics"], x: 0, y: 0, ideas,
	counts: { seen: ideas.length, held: 0, fast: 0 }, glow: ideas.length > 0 ? 0.5 : 0,
});
const model = (over: Partial<ForestModel> = {}): ForestModel => ({
	topics: [topic("t1", ["n1"]), topic("t2")], regions: [{ degreeId: "physics", name: "Physics", x: 0, y: 0 }], trails: [],
	uncharted: [], unplaced: 0, unpositioned: 0, coverage: { mapped: 1, total: 2 }, ...over,
});
const snap = (m: ForestModel | null, propositions: GraphNode[] = [node("n1", "Idea one")]): ForestSnapshot => ({
	model: m,
	graph: { propositions, chains: [], sessions: {}, fileSources: {}, nodeSessions: {} },
});

let host: HTMLElement | null = null;
let unmount: (() => Promise<void>) | null = null;
async function mount(s: ForestSnapshot): Promise<HTMLElement> {
	snapshot = s;
	fetched = [];
	host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	unmount = async () => { await act(async () => root.unmount()); };
	const connect = () => ({ close() {}, onOpen() {}, onEvent() {} });
	await act(async () => {
		root.render(<ServerEventsProvider connect={connect}><ForestView /></ServerEventsProvider>);
	});
	// Let the fetch -> json -> setState chain settle.
	for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
	return host;
}
afterEach(async () => {
	await unmount?.();
	host?.remove();
	host = null;
	unmount = null;
});

describe("ForestView empty states", () => {
	it("shows the generate step with no world", async () => {
		const el = await mount(snap(null));
		const text = el.textContent ?? "";
		assert.ok(text.includes("npm run world:generate"), text);
		assert.ok(text.includes("npm run world:layout"), text);
		assert.ok(text.indexOf("npm run world:generate") < text.indexOf("npm run world:layout"));
		assert.equal(el.querySelector('a[href="/graph"]')?.getAttribute("href"), "/graph");
		assert.deepEqual(fetched, ["/api/forest"]);
	});

	it("shows the layout step when topics have no positions", async () => {
		const el = await mount(snap(model({ topics: [], regions: [], unpositioned: 12, coverage: { mapped: 0, total: 0 } })));
		const text = el.textContent ?? "";
		assert.ok(text.includes("npm run world:layout"), text);
		assert.ok(!text.includes("world:generate"), text);
	});
});

describe("ForestView overlays", () => {
	it("renders the coverage line", async () => {
		const el = await mount(snap(model({ coverage: { mapped: 7, total: 10000 } })));
		assert.ok((el.textContent ?? "").includes("Mapped 0.07% of undergrad STEM"), el.textContent ?? "");
		assert.ok(el.querySelector("canvas"), "the canvas stage renders");
	});

	it("draws a forest with no lit topics at a 0x0 canvas without throwing", async () => {
		const el = await mount(snap(model({ topics: [topic("t1"), topic("t2")], coverage: { mapped: 0, total: 2 } })));
		assert.ok(el.querySelector("canvas"));
		assert.ok((el.textContent ?? "").includes("Mapped 0% of undergrad STEM"), el.textContent ?? "");
	});

	it("lists uncharted ideas", async () => {
		const props = [node("n1", "Idea one"), node("n2", "Entropy"), node("n3", "Free energy")];
		const el = await mount(snap(model({ uncharted: ["n2", "n3"] }), props));
		const toggle = Array.from(el.querySelectorAll("button")).find((b) => (b.textContent ?? "").includes("Uncharted (2)"));
		assert.ok(toggle, "collapsed control exists");
		assert.ok(!(el.textContent ?? "").includes("Entropy"), "collapsed: names hidden");
		await act(async () => { toggle.dispatchEvent(new dom.window.Event("click", { bubbles: true })); });
		const text = el.textContent ?? "";
		assert.ok(text.includes("Entropy") && text.includes("Free energy"), text);
	});

	it("shows waiting ideas", async () => {
		let el = await mount(snap(model({ unplaced: 3 })));
		assert.ok((el.textContent ?? "").includes("3 ideas waiting to be placed"), el.textContent ?? "");
		await unmount?.();
		host?.remove();
		el = await mount(snap(model({ unplaced: 0 })));
		assert.ok(!(el.textContent ?? "").includes("waiting to be placed"), el.textContent ?? "");
	});
});

describe("ForestIdeaCard", () => {
	it("shows statement, chains and sessions", () => {
		const a = node("n1", "Premise A");
		const b = node("n2", "Premise B");
		const c = node("n3", "The conclusion", {
			statement: "A thing that follows.",
			provenance: [{ chatId: "chat_1", messageId: "m_9" } as GraphNode["provenance"][number]],
		});
		const chains: GraphChain[] = [
			{ id: "arg_1", premises: ["n1", "n2"], conclusion: "n3", provenance: [], createdAt: "2026-11-01T00:00:00.000Z" } as GraphChain,
			{ id: "arg_2", premises: ["n3"], conclusion: "n1", provenance: [], createdAt: "2026-11-01T00:00:00.000Z" } as GraphChain,
		];
		const html = renderToStaticMarkup(
			<ForestIdeaCard
				node={c}
				nodes={[a, b, c]}
				chains={chains}
				sessions={{ chat_1: "Thermo chat" }}
				fileSources={{ src_1: "notes/thermo.md" }}
				nodeSessions={{ n3: ["chat_1", "src_1"] }}
			/>,
		);
		assert.ok(html.includes("A thing that follows."), html);
		assert.ok(html.includes("Premise A, Premise B") && html.includes("⟹"), html);
		assert.ok(html.includes("The conclusion"), html);
		const href = propositionSessionHref(c, "chat_1");
		assert.ok(html.includes(`href="${href}"`), html);
		assert.ok(html.includes("Thermo chat"), html);
		assert.ok(html.includes("notes/thermo.md") && !html.includes('href="/chat/src_1'), "file sources are plain text");
	});

	it("falls back to the id for an unknown chain member and omits empty sections", () => {
		const c = node("n3", "Alone");
		const html = renderToStaticMarkup(
			<ForestIdeaCard node={c} chains={[{ id: "arg_9", premises: ["n_gone"], conclusion: "n3", provenance: [], createdAt: "" } as GraphChain]} sessions={{}} fileSources={{}} nodeSessions={{}} />,
		);
		assert.ok(html.includes("n_gone"), html);
		assert.ok(!html.includes("Sessions"), html);
	});
});
