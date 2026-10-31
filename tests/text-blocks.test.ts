import assert from "node:assert/strict";
import test from "node:test";

import { joinTextBlocks } from "../src/core/text-blocks.ts";

test("joinTextBlocks separates text blocks with a blank line", () => {
	assert.equal(joinTextBlocks([{ type: "text", text: "one" }, { type: "text", text: "two" }, { type: "text", text: "three" }]), "one\n\ntwo\n\nthree");
});

test("joinTextBlocks skips empty and whitespace-only blocks and non-text blocks", () => {
	assert.equal(
		joinTextBlocks([{ type: "text", text: "" }, { type: "thinking" }, { type: "text", text: "one" }, { type: "text", text: "  \n" }, { type: "toolCall" }, { type: "text", text: "two" }]),
		"one\n\ntwo",
	);
	assert.equal(joinTextBlocks([]), "");
});

test("joinTextBlocks leaves a single block untouched", () => {
	assert.equal(joinTextBlocks([{ type: "text", text: " keep spacing\n" }]), " keep spacing\n");
});
