import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";

const dom = parseHTML("<html><body></body></html>");
class TestObserver {
	constructor(readonly callback: () => void) {}
	observe() {} unobserve() {} disconnect() {}
}
const pending = () => new Promise(() => {});
Object.assign(globalThis, {
	window: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement,
	IS_REACT_ACT_ENVIRONMENT: true,
	ResizeObserver: TestObserver,
	IntersectionObserver: TestObserver,
	self: globalThis,
	requestAnimationFrame: () => 1,
	cancelAnimationFrame: () => {},
	getComputedStyle: () => ({ getPropertyValue: () => "", fontFamily: "" }),
	fetch: pending, // nothing settles: only the first-paint chrome matters here
});
Object.assign(dom.window, { devicePixelRatio: 1, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });

const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime");
const { Home } = await import("../components/home.tsx");
const { ServerEventsProvider } = await import("../components/server-events.tsx");

const router = {
	push() {}, replace() {}, back() {}, forward() {}, refresh() {}, prefetch() {},
} as never;
const connect = () => ({ close() {}, onOpen() {}, onEvent() {} });

let host: HTMLElement | null = null;
let unmount: (() => Promise<void>) | null = null;
async function mount(props: Partial<Parameters<typeof Home>[0]>): Promise<HTMLElement> {
	host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	unmount = async () => { await act(async () => root.unmount()); };
	await act(async () => {
		root.render(
			<AppRouterContext.Provider value={router}>
				<ServerEventsProvider connect={connect}><Home initialConfigured {...props} /></ServerEventsProvider>
			</AppRouterContext.Provider>,
		);
	});
	return host;
}
async function practiceMode(el: HTMLElement) {
	const btn = el.querySelector('[data-testid="home-mode-practice"]') as HTMLElement | null;
	assert.ok(btn, "the practice toggle renders");
	await act(async () => { btn.click(); });
}
afterEach(async () => {
	await unmount?.();
	host?.remove();
	host = null;
	unmount = null;
});

describe("Home: the practice node picker only where it works", () => {
	it("forest: Practice mode shows no Pick nodes chip (ForestView takes no picks)", async () => {
		const el = await mount({ view: "forest" });
		await practiceMode(el);
		assert.equal(el.querySelector('[data-testid="practice-props-chip"]'), null);
	});

	it("graph: Practice mode shows the chip", async () => {
		const el = await mount({ view: "graph" });
		await practiceMode(el);
		assert.ok(el.querySelector('[data-testid="practice-props-chip"]'));
	});

	it("rendering off (MinimalHome): Practice mode still shows the chip, as before", async () => {
		const el = await mount({ view: "forest", rendering: false });
		await practiceMode(el);
		assert.ok(el.querySelector('[data-testid="practice-props-chip"]'));
	});
});
