import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { PlanLimitNote } from "../components/plan-limit-note.tsx";
import type { LhMessage } from "../src/core/native-messages.ts";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
	CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined, host: HTMLDivElement | undefined;
afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); root = undefined; });

const warned = (resetsAt: number) => [{ role: "assistant", content: [], id: "a", provider: "claude-code", model: "opus", cliRateLimit: { status: "allowed_warning", resetsAt } } as unknown as LhMessage];
const inHours = (hours: number) => Math.floor((Date.now() + hours * 3_600_000) / 1000);
const note = () => document.querySelector('[data-testid="cli-notice"]');

test("the plan-limit note shows a warning on the CLI backend, relative to now, and hides otherwise", async () => {
	host = document.createElement("div"); document.body.append(host); root = createRoot(host);
	const render = (messages: LhMessage[], selectedModel: string | undefined) => root!.render(<PlanLimitNote messages={messages} selectedModel={selectedModel} />);
	await act(async () => render(warned(inHours(3)), "claude-code:opus"));
	assert.match(note()?.textContent ?? "", /^Claude plan limit almost reached\. It resets in 3 hours\. Switch this lesson to your API key/);
	assert.equal(note()?.getAttribute("role"), "status");
	await act(async () => render(warned(inHours(3)), "anthropic:claude-opus-4-5"));
	assert.equal(note(), null, "after a switch to the API the CLI's plan note is gone");
	await act(async () => render(warned(Math.floor(Date.now() / 1000) - 30), "claude-code:opus"));
	assert.equal(note(), null, "a reset time already past hides the note");
	await act(async () => render([], "claude-code:opus"));
	assert.equal(note(), null);
});

test("the note disappears by itself when its reset time passes", async () => {
	host = document.createElement("div"); document.body.append(host); root = createRoot(host);
	await act(async () => root!.render(<PlanLimitNote messages={warned(Math.floor(Date.now() / 1000) + 1)} selectedModel="claude-code:opus" />));
	assert.ok(note(), "visible before the reset time");
	await act(async () => { await new Promise((resolve) => setTimeout(resolve, 2300)); });
	assert.equal(note(), null);
});
