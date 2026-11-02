import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import type { ForestModel, ForestSnapshot, ForestTopic, GraphChain, GraphNode } from "../src/core/index.ts";
import { propositionSessionHref } from "../src/core/index.ts";

const dom = parseHTML("<html><body></body></html>");
// A canvas 2D context that accepts everything: property writes are kept,
// method calls and gradient objects are inert.
let fills = 0; // fillRect calls: proof the renderer's draw() ran
let contextAvailable = true;
const noopContext = (): CanvasRenderingContext2D | null => {
	if (!contextAvailable) return null;
	const store: Record<string | symbol, unknown> = {};
	const callable = (prop: string | symbol) => new Proxy(function () {}, {
		get: (_t, p) => (p === "addColorStop" ? () => {} : undefined),
		apply: () => {
			if (prop === "fillRect") fills++;
			if (prop === "createRadialGradient" || prop === "createLinearGradient") return { addColorStop() {} };
			return undefined;
		},
	});
	return new Proxy(store, {
		get: (target, prop) => (prop in target ? target[prop] : callable(prop)),
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
// An in-memory localStorage that logs every read, to see which camera key the view uses.
const storage = new Map<string, string>();
let storageReads: string[] = [];
Object.assign(globalThis, {
	localStorage: {
		getItem: (k: string) => { storageReads.push(k); return storage.get(k) ?? null; },
		setItem: (k: string, v: string) => { storage.set(k, v); },
		removeItem: (k: string) => { storage.delete(k); },
	},
});
let fetched: string[] = [];
let snapshot: ForestSnapshot | null = null;
/** ok: resolve the snapshot; http500 / network: fail; pending: never settle. */
let fetchMode: "ok" | "http500" | "network" | "pending" = "ok";
Object.assign(globalThis, {
	window: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement,
	IS_REACT_ACT_ENVIRONMENT: true,
	ResizeObserver: TestObserver,
	IntersectionObserver: TestIntersectionObserver, // next/link prefetch
	self: globalThis,
	Path2D: TestPath2D,
	// Runs the frame callback (after frameId is assigned) so draw() really executes.
	requestAnimationFrame: (cb: (t: number) => void) => { queueMicrotask(() => cb(0)); return 1; },
	cancelAnimationFrame: () => {},
	getComputedStyle: () => ({ getPropertyValue: () => "", fontFamily: "" }),
	fetch: async (url: string) => {
		fetched.push(String(url));
		if (fetchMode === "pending") return new Promise(() => {});
		if (fetchMode === "network") throw new Error("offline");
		if (fetchMode === "http500") return { ok: false, status: 500, json: async () => ({}) };
		return { ok: true, json: async () => snapshot };
	},
});
Object.assign(dom.window, { devicePixelRatio: 1, addEventListener: dom.window.addEventListener.bind(dom.window) });
(dom.window as unknown as { HTMLCanvasElement: typeof HTMLCanvasElement }).HTMLCanvasElement.prototype.getContext = noopContext as never;
Object.assign(globalThis, { HTMLCanvasElement: (dom.window as unknown as { HTMLCanvasElement: unknown }).HTMLCanvasElement });

// Import after installing the DOM globals.
const { ForestView } = await import("../components/forest-view.tsx");
const { ForestCanvasRenderer } = await import("../components/forest-canvas.ts");
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
	worldKey: "w-a",
	topics: [topic("t1", ["n1"]), topic("t2")], regions: [{ degreeId: "physics", name: "Physics", x: 0, y: 0, topics: 2 }], trails: [],
	uncharted: [], unplaced: 0, unpositioned: 0, coverage: { mapped: 1, total: 2 }, ...over,
});
const snap = (m: ForestModel | null, propositions: GraphNode[] = [node("n1", "Idea one")]): ForestSnapshot => ({
	model: m,
	graph: { propositions, chains: [], sessions: {}, fileSources: {}, nodeSessions: {} },
});

let host: HTMLElement | null = null;
let unmount: (() => Promise<void>) | null = null;
async function mount(s: ForestSnapshot | null): Promise<HTMLElement> {
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
	storage.clear();
	storageReads = [];
	fetchMode = "ok";
	contextAvailable = true;
	await unmount?.();
	host?.remove();
	host = null;
	unmount = null;
});

describe("ForestView empty states", () => {
	it("lists generate, dedupe, layout in order with no world", async () => {
		const el = await mount(snap(null));
		const text = el.textContent ?? "";
		const at = (cmd: string) => text.indexOf(`npm run world:${cmd}`);
		assert.ok(at("generate") >= 0 && at("dedupe") >= 0 && at("layout") >= 0, text);
		assert.ok(at("generate") < at("dedupe") && at("dedupe") < at("layout"), text);
		assert.equal(el.querySelector('a[href="/graph"]')?.getAttribute("href"), "/graph");
		assert.deepEqual(fetched, ["/api/forest"]);
	});

	it("offers dedupe as 'if you haven't yet' before layout when topics have no positions", async () => {
		const el = await mount(snap(model({ topics: [], regions: [], unpositioned: 12, coverage: { mapped: 0, total: 0 } })));
		const text = el.textContent ?? "";
		assert.ok(text.includes("npm run world:layout"), text);
		assert.ok(text.includes("npm run world:dedupe"), text);
		assert.ok(text.includes("if you haven't yet"), text);
		assert.ok(text.indexOf("npm run world:dedupe") < text.indexOf("npm run world:layout"), text);
		assert.ok(!text.includes("world:generate"), text);
	});
});

describe("ForestView load and error states", () => {
	const button = (el: HTMLElement, label: string) =>
		Array.from(el.querySelectorAll("button")).find((b) => (b.textContent ?? "").trim() === label);

	it("shows Loading while the first fetch is pending", async () => {
		fetchMode = "pending";
		const el = await mount(snap(model()));
		assert.ok((el.textContent ?? "").includes("Loading"), el.textContent ?? "");
		assert.ok(!(el.textContent ?? "").includes("Couldn't load"));
	});

	for (const mode of ["http500", "network"] as const) {
		it(`shows an error with Retry when the fetch fails (${mode}), and Retry recovers`, async () => {
			fetchMode = mode;
			const errors = console.error;
			console.error = () => {};
			try {
				const el = await mount(snap(model({ coverage: { mapped: 7, total: 10000 } })));
				assert.ok((el.textContent ?? "").includes("Couldn't load the forest"), el.textContent ?? "");
				assert.ok(!(el.textContent ?? "").includes("Loading"));
				const retry = button(el, "Retry");
				assert.ok(retry, "Retry button");
				fetchMode = "ok";
				await act(async () => { retry.dispatchEvent(new dom.window.Event("click", { bubbles: true })); });
				for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
				assert.equal(fetched.length, 2, "Retry fetched again");
				assert.ok((el.textContent ?? "").includes("Mapped 0.07% of undergrad STEM"), el.textContent ?? "");
				assert.ok(!(el.textContent ?? "").includes("Couldn't load"));
			} finally {
				console.error = errors;
			}
		});
	}

	it("keeps the previous forest when a later refetch fails", async () => {
		const el = await mount(snap(model({ coverage: { mapped: 7, total: 10000 } })));
		fetchMode = "network";
		const errors = console.error;
		console.error = () => {};
		try {
			await act(async () => { dom.window.dispatchEvent(new dom.window.Event("lh:graph-revision")); });
			for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
		} finally {
			console.error = errors;
		}
		assert.equal(fetched.length, 2);
		const text = el.textContent ?? "";
		assert.ok(text.includes("Mapped 0.07% of undergrad STEM"), text);
		assert.ok(!text.includes("Couldn't load the forest"), text);
	});
});

describe("ForestView overlays", () => {
	it("renders the coverage line", async () => {
		const el = await mount(snap(model({ coverage: { mapped: 7, total: 10000 } })));
		assert.ok((el.textContent ?? "").includes("Mapped 0.07% of undergrad STEM"), el.textContent ?? "");
		assert.ok(el.querySelector("canvas"), "the canvas stage renders");
	});

	it("draws a forest with no lit topics at a 0x0 canvas without throwing", async () => {
		fills = 0;
		const el = await mount(snap(model({ topics: [topic("t1"), topic("t2")], coverage: { mapped: 0, total: 2 } })));
		assert.ok(el.querySelector("canvas"));
		assert.ok(fills > 0, "draw() ran against the 0x0 canvas");
		assert.ok((el.textContent ?? "").includes("Mapped 0% of undergrad STEM"), el.textContent ?? "");
	});

	it("says so when the canvas context is unavailable instead of crashing", async () => {
		contextAvailable = false;
		const errors = console.error;
		console.error = () => {};
		try {
			const el = await mount(snap(model()));
			assert.ok((el.textContent ?? "").includes("Canvas unavailable"), el.textContent ?? "");
		} finally {
			console.error = errors;
		}
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

describe("ForestView partly laid-out world", () => {
	it("says how many topics still need a layout", async () => {
		let el = await mount(snap(model({ unpositioned: 3 })));
		assert.ok((el.textContent ?? "").includes("3 topics not laid out yet — npm run world:layout"), el.textContent ?? "");
		await unmount?.();
		host?.remove();
		el = await mount(snap(model({ unpositioned: 1 })));
		assert.ok((el.textContent ?? "").includes("1 topic not laid out yet"), el.textContent ?? "");
		await unmount?.();
		host?.remove();
		el = await mount(snap(model({ unpositioned: 0 })));
		assert.ok(!(el.textContent ?? "").includes("not laid out yet"), el.textContent ?? "");
	});

	it("shows the refresh-failed note alongside a pinned idea card", async () => {
		const props = [node("n1", "Idea one"), node("n2", "Entropy")];
		const el = await mount(snap(model({ uncharted: ["n2"] }), props));
		const toggle = Array.from(el.querySelectorAll("button")).find((b) => (b.textContent ?? "").includes("Uncharted (1)"));
		assert.ok(toggle);
		await act(async () => { toggle.dispatchEvent(new dom.window.Event("click", { bubbles: true })); });
		const entry = Array.from(el.querySelectorAll("button")).find((b) => (b.textContent ?? "").trim() === "Entropy");
		assert.ok(entry);
		await act(async () => { entry.dispatchEvent(new dom.window.Event("click", { bubbles: true })); });
		fetchMode = "network";
		const errors = console.error;
		console.error = () => {};
		try {
			await act(async () => { dom.window.dispatchEvent(new dom.window.Event("lh:graph-revision")); });
			for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
		} finally {
			console.error = errors;
		}
		assert.ok(el.querySelector('[data-testid="forest-idea-card"]'), "pinned card shows");
		const note = Array.from(el.querySelectorAll("div")).find((d) => (d.textContent ?? "") === "Couldn't refresh");
		assert.ok(note, "note shows");
		assert.ok(!note.closest('[data-testid="forest-idea-card"]'));
		assert.ok(!(note.getAttribute("class") ?? "").includes("right-3"), "the note does not sit in the card's top-right slot");
	});
});

describe("ForestView camera and Fit world", () => {
	const keyOf = (worldKey: string) => `lh.forest.camera.v2:${worldKey}`;
	const proto = ForestCanvasRenderer.prototype as unknown as { fitWorld: () => void };
	const realFit = proto.fitWorld;
	let fitCalls = 0;
	beforeEach(() => {
		fitCalls = 0;
		proto.fitWorld = function (this: unknown) { fitCalls++; return realFit.call(this); };
	});
	afterEach(() => { proto.fitWorld = realFit; });
	const keydown = async (key: string) => {
		const e = new dom.window.Event("keydown", { bubbles: true });
		Object.assign(e, { key });
		await act(async () => { dom.window.dispatchEvent(e); });
	};

	it("reads the stored camera under a key that names the world", async () => {
		await mount(snap(model({ worldKey: "gen-1|10|abc" })));
		assert.ok(storageReads.includes(keyOf("gen-1|10|abc")), storageReads.join(","));
		assert.ok(!storageReads.includes("lh.forest.camera.v1"), "the world-less key is gone");
	});

	it("does not hand one world's camera to another", async () => {
		storage.set(keyOf("w-a"), JSON.stringify({ k: 0.5, x: 1, y: 2 }));
		await mount(snap(model({ worldKey: "w-b" })));
		assert.ok(storageReads.includes(keyOf("w-b")));
		assert.ok(!storageReads.includes(keyOf("w-a")), "world A's camera is never read for world B");
	});

	it("switches camera key when a refetch brings a different world", async () => {
		await mount(snap(model({ worldKey: "w-a" })));
		storageReads = [];
		snapshot = snap(model({ worldKey: "w-b" }));
		await act(async () => { dom.window.dispatchEvent(new dom.window.Event("lh:graph-revision")); });
		for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
		assert.ok(storageReads.includes(keyOf("w-b")), storageReads.join(","));
	});

	it("never fits a canvas the padding swallows (no mirrored camera), but fits a real one", async () => {
		const canvasProto = (dom.window as unknown as { HTMLCanvasElement: { prototype: object } }).HTMLCanvasElement.prototype;
		const size = { w: 60, h: 60 };
		Object.defineProperty(canvasProto, "clientWidth", { configurable: true, get: () => size.w });
		Object.defineProperty(canvasProto, "clientHeight", { configurable: true, get: () => size.h });
		try {
			const stored = () => [...storage.entries()].filter(([k]) => k.startsWith("lh.forest.camera.v2:"));
			await mount(snap(model()));
			await unmount?.();
			assert.deepEqual(stored(), [], "a 60x60 canvas (padding 40 per side) is not fitted");
			host?.remove();
			size.w = 800;
			size.h = 600;
			await mount(snap(model()));
			await unmount?.();
			const [entry] = stored();
			assert.ok(entry, "an 800x600 canvas is fitted and its camera persisted");
			assert.ok((JSON.parse(entry[1]) as { k: number }).k > 0, "the fitted zoom is positive");
		} finally {
			delete (canvasProto as Record<string, unknown>).clientWidth;
			delete (canvasProto as Record<string, unknown>).clientHeight;
		}
	});

	it("frames the world from the Fit world button", async () => {
		const el = await mount(snap(model()));
		const btn = Array.from(el.querySelectorAll("button")).find((b) => (b.textContent ?? "").trim() === "Fit world");
		assert.ok(btn, "button exists");
		const before = fitCalls;
		await act(async () => { btn.dispatchEvent(new dom.window.Event("click", { bubbles: true })); });
		assert.equal(fitCalls, before + 1);
	});

	it("frames the world on f, but not while typing", async () => {
		const el = await mount(snap(model()));
		const before = fitCalls;
		await keydown("f");
		assert.equal(fitCalls, before + 1, "f fits");
		await keydown("x");
		assert.equal(fitCalls, before + 1, "other keys do nothing");
		const input = document.createElement("textarea");
		el.append(input);
		Object.defineProperty(document, "activeElement", { configurable: true, get: () => input });
		try {
			await keydown("f");
			assert.equal(fitCalls, before + 1, "typing in a field does not fit");
		} finally {
			delete (document as unknown as Record<string, unknown>).activeElement;
		}
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
