/**
 * Tests for the world generation script (scripts/world/generate.ts) with a
 * FAKE `ask` — no test ever invokes the real claude binary.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { claudeEnv, type runClaudeJson } from "../scripts/world/claude-cli.ts";
import { generateWorld } from "../scripts/world/generate.ts";
import type { CourseTopicsBatch } from "../src/core/contracts/world.ts";
import { topicSlug } from "../src/core/world.ts";

const degrees = [{ id: "math", name: "Mathematics" }];

let buildDir = "";
beforeEach(() => {
	buildDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-world-gen-"));
});
afterEach(() => {
	fs.rmSync(buildDir, { recursive: true, force: true });
});

interface Call {
	kind: "courses" | "topics";
	prompt: string;
}

/** A fake ask: a courses reply, then per-course topics replies from `topics`. */
function fakeAsk(topics: (course: string, attempt: number) => unknown, calls: Call[] = []): typeof runClaudeJson {
	const attempts = new Map<string, number>();
	return (async (o: { prompt: string }) => {
		if (o.prompt.includes("List the courses")) {
			calls.push({ kind: "courses", prompt: o.prompt });
			return { courses: ["A", "B"] };
		}
		const course = /^Course: (.+)$/m.exec(o.prompt)?.[1] ?? "?";
		const n = (attempts.get(course) ?? 0) + 1;
		attempts.set(course, n);
		calls.push({ kind: "topics", prompt: o.prompt });
		return topics(course, n);
	}) as unknown as typeof runClaudeJson;
}

const good = (course: string): CourseTopicsBatch => ({
	degree: "math",
	course,
	topics: [{ name: `Topic of ${course}`, scope: "A scope.", prereqs: [] }],
});

describe("generateWorld", () => {
	it("asks for courses, then topics per course, and writes each batch", async () => {
		const calls: Call[] = [];
		const batches = await generateWorld({
			degrees,
			buildDir,
			ask: fakeAsk((course) => good(course), calls),
			log: () => {},
		});
		assert.deepEqual(calls.map((c) => c.kind), ["courses", "topics", "topics"]);
		assert.equal(batches.length, 2);
		for (const b of batches) {
			const file = path.join(buildDir, "math", `${topicSlug(b.course)}.json`);
			assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf-8")), b);
		}
	});

	it("resumes: a course already on disk is not asked again", async () => {
		fs.mkdirSync(path.join(buildDir, "math"), { recursive: true });
		fs.writeFileSync(path.join(buildDir, "math", "a.json"), JSON.stringify(good("A")));
		const calls: Call[] = [];
		const batches = await generateWorld({
			degrees,
			buildDir,
			ask: fakeAsk((course) => good(course), calls),
			log: () => {},
		});
		assert.equal(calls.filter((c) => c.kind === "topics").length, 1);
		assert.ok(!calls.some((c) => c.prompt.includes("Course: A\n")));
		assert.deepEqual(batches.map((b) => b.course).sort(), ["A", "B"]);
	});

	it("retries a bad topics reply once, then skips and logs it", async () => {
		const calls: Call[] = [];
		const logs: string[] = [];
		const batches = await generateWorld({
			degrees,
			buildDir,
			ask: fakeAsk((course) => (course === "A" ? { nope: true } : good(course)), calls),
			log: (s) => logs.push(s),
		});
		assert.equal(calls.filter((c) => c.prompt.includes("Course: A\n")).length, 2);
		assert.deepEqual(batches.map((b) => b.course), ["B"]);
		assert.ok(!fs.existsSync(path.join(buildDir, "math", "a.json")));
		assert.ok(fs.existsSync(path.join(buildDir, "math", "b.json")));
		assert.ok(logs.some((l) => /skip/i.test(l) && l.includes("A")));
	});

	it("recovers when the retry succeeds", async () => {
		const batches = await generateWorld({
			degrees,
			buildDir,
			ask: fakeAsk((course, n) => (course === "A" && n === 1 ? { nope: true } : good(course))),
			log: () => {},
		});
		assert.deepEqual(batches.map((b) => b.course), ["A", "B"]);
	});
});

describe("generateWorld: robustness", () => {
	const emptyBatch = (course: string): CourseTopicsBatch => ({ degree: "math", course, topics: [] });

	it("treats an empty topics list as a bad reply: retried once, skipped, nothing written", async () => {
		const calls: Call[] = [];
		const logs: string[] = [];
		const batches = await generateWorld({
			degrees,
			buildDir,
			ask: fakeAsk((course) => (course === "A" ? emptyBatch(course) : good(course)), calls),
			log: (s) => logs.push(s),
		});
		assert.equal(calls.filter((c) => c.prompt.includes("Course: A\n")).length, 2);
		assert.deepEqual(batches.map((b) => b.course), ["B"]);
		assert.ok(!fs.existsSync(path.join(buildDir, "math", "a.json")));
		assert.ok(logs.some((l) => /skip/i.test(l) && l.includes("A")));
	});

	it("does not trust an empty cached batch on resume", async () => {
		fs.mkdirSync(path.join(buildDir, "math"), { recursive: true });
		fs.writeFileSync(path.join(buildDir, "math", "a.json"), JSON.stringify(emptyBatch("A")));
		const calls: Call[] = [];
		const batches = await generateWorld({
			degrees,
			buildDir,
			ask: fakeAsk((course) => good(course), calls),
			log: () => {},
		});
		assert.equal(calls.filter((c) => c.prompt.includes("Course: A\n")).length, 1);
		assert.deepEqual(batches.map((b) => b.course), ["A", "B"]);
		const onDisk = JSON.parse(fs.readFileSync(path.join(buildDir, "math", "a.json"), "utf-8"));
		assert.equal(onDisk.topics.length, 1);
	});

	it("aborts after 3 consecutive course failures and keeps earlier batches", async () => {
		const courses = ["A", "B", "C", "D", "E", "F"];
		const calls: Call[] = [];
		const logs: string[] = [];
		const ask = (async (o: { prompt: string }) => {
			if (o.prompt.includes("List the courses")) return { courses };
			const course = /^Course: (.+)$/m.exec(o.prompt)?.[1] ?? "?";
			calls.push({ kind: "topics", prompt: o.prompt });
			if (course === "A") return good("A");
			throw new Error("usage limit reached");
		}) as unknown as typeof runClaudeJson;
		const batches = await generateWorld({ degrees, buildDir, ask, log: (s) => logs.push(s) });
		assert.deepEqual(batches.map((b) => b.course), ["A"]);
		assert.ok(fs.existsSync(path.join(buildDir, "math", "a.json")));
		// A once, then B, C, D twice each (retry) - E and F never asked.
		assert.equal(calls.length, 1 + 3 * 2);
		assert.ok(!calls.some((c) => /Course: [EF]\n/.test(c.prompt)));
		assert.ok(logs.some((l) => /stopped early/i.test(l) && /resume/i.test(l)));
	});

	it("a success resets the failure streak", async () => {
		const courses = ["A", "B", "C", "D", "E", "F", "G"];
		const bad = new Set(["A", "B", "D", "E"]);
		const ask = (async (o: { prompt: string }) => {
			if (o.prompt.includes("List the courses")) return { courses };
			const course = /^Course: (.+)$/m.exec(o.prompt)?.[1] ?? "?";
			return bad.has(course) ? { nope: true } : good(course);
		}) as unknown as typeof runClaudeJson;
		const batches = await generateWorld({ degrees, buildDir, ask, log: () => {} });
		assert.deepEqual(batches.map((b) => b.course), ["C", "F", "G"]);
	});
});

describe("generateWorld: course lists", () => {
	const fourDegrees = [
		{ id: "math", name: "Mathematics" },
		{ id: "physics", name: "Physics" },
		{ id: "ee", name: "Electrical Engineering" },
		{ id: "cs", name: "Computer Science" },
	];

	it("treats an empty course list as a bad reply: retried once, degree skipped, nothing cached", async () => {
		let listCalls = 0;
		const logs: string[] = [];
		const ask = (async (o: { prompt: string }) => {
			if (o.prompt.includes("List the courses")) {
				listCalls++;
				return { courses: [] };
			}
			throw new Error("no topics should be asked");
		}) as unknown as typeof runClaudeJson;
		const batches = await generateWorld({ degrees, buildDir, ask, log: (s) => logs.push(s) });
		assert.equal(listCalls, 2);
		assert.deepEqual(batches, []);
		assert.ok(!fs.existsSync(path.join(buildDir, "math", "_courses.json")));
		assert.ok(logs.some((l) => /skip/i.test(l) && l.includes("Mathematics")));
	});

	it("does not trust an empty cached course list on resume", async () => {
		fs.mkdirSync(path.join(buildDir, "math"), { recursive: true });
		fs.writeFileSync(path.join(buildDir, "math", "_courses.json"), JSON.stringify({ courses: [] }));
		const calls: Call[] = [];
		const batches = await generateWorld({ degrees, buildDir, ask: fakeAsk((c) => good(c), calls), log: () => {} });
		assert.equal(calls.filter((c) => c.kind === "courses").length, 1);
		assert.deepEqual(batches.map((b) => b.course), ["A", "B"]);
		const cached = JSON.parse(fs.readFileSync(path.join(buildDir, "math", "_courses.json"), "utf-8"));
		assert.deepEqual(cached, { courses: ["A", "B"] });
	});

	it("counts failed course lists toward the 3-in-a-row stop", async () => {
		const asked: string[] = [];
		const logs: string[] = [];
		const ask = (async (o: { prompt: string }) => {
			asked.push(o.prompt);
			throw new Error("usage limit reached");
		}) as unknown as typeof runClaudeJson;
		const batches = await generateWorld({ degrees: fourDegrees, buildDir, ask, log: (s) => logs.push(s) });
		assert.deepEqual(batches, []);
		// Three degrees, two attempts each; the fourth degree is never asked.
		assert.equal(asked.length, 3 * 2);
		assert.ok(!asked.some((p) => p.includes("Computer Science")));
		assert.ok(logs.some((l) => /stopped early/i.test(l) && /resume/i.test(l)));
	});

	it("a course-list failure adds to a streak of course failures", async () => {
		const asked: string[] = [];
		const ask = (async (o: { prompt: string }) => {
			asked.push(o.prompt);
			if (o.prompt.includes("List the courses")) {
				if (o.prompt.includes("Mathematics")) return { courses: ["A", "B"] };
				throw new Error("usage limit reached");
			}
			return { nope: true };
		}) as unknown as typeof runClaudeJson;
		const batches = await generateWorld({ degrees: fourDegrees, buildDir, ask, log: () => {} });
		assert.deepEqual(batches, []);
		// math list, A ×2, B ×2 (2 failures), physics list ×2 (3rd failure) - stop.
		assert.equal(asked.length, 1 + 2 + 2 + 2);
		assert.ok(!asked.some((p) => p.includes("Electrical Engineering")));
	});
});

describe("claudeEnv", () => {
	it("drops ANTHROPIC_API_KEY so the plan, not the API, is billed", () => {
		assert.deepEqual(claudeEnv({ ANTHROPIC_API_KEY: "x", PATH: "p" }), { PATH: "p" });
		assert.deepEqual(claudeEnv({ anthropic_api_key: "x", PATH: "p" }), { PATH: "p" });
	});
});
