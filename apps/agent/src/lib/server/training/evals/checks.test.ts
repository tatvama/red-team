// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredMessage } from "../../db";
import type { CompletionFn } from "../../llm";
import {
  evaluateCheck,
  isInvalidToolResult,
  parseJudgeReply,
  regexTest,
  scoreOutcomes,
  transcriptOf,
  type CheckContext,
  type CheckOutcome,
  type Transcript,
} from "./checks";
import type { EvalCheck } from "./suite";

let root: string;
let taskDir: string;
let fixtureDir: string;

function write(dir: string, file: string, content: string) {
  mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  writeFileSync(path.join(dir, file), content);
}

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "tatvam-checks-"));
  taskDir = path.join(root, "task");
  fixtureDir = path.join(root, "fixture");
  write(fixtureDir, "src/sum.js", "for (let i = 0; i <= count; i++) {}\n");
  write(fixtureDir, "README.md", "# Readme\n");
  write(taskDir, "src/sum.js", "for (let i = 0; i < count; i++) {}\n");
  write(taskDir, "README.md", "# Readme\n");
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const transcript = (overrides: Partial<Transcript> = {}): Transcript => ({
  answer: "The port is 8417.",
  steps: 3,
  calls: [
    { name: "read_file", arguments: "{}", status: "ok", output: "..." },
    { name: "read_file", arguments: "{}", status: "error", output: "Not found: x" },
    { name: "calculator", arguments: "{", status: "error", output: "The arguments were not valid JSON. Send a single JSON object." },
  ],
  invalidToolCalls: 1,
  models: ["m"],
  ...overrides,
});

const neverCalled: CompletionFn = async () => {
  throw new Error("The judge should not be called");
};

function context(overrides: Partial<CheckContext> = {}): CheckContext {
  return {
    taskDir,
    fixtureDir,
    prompt: "Which port?",
    transcript: transcript(),
    judge: null,
    judgeComplete: neverCalled,
    signal: new AbortController().signal,
    ...overrides,
  };
}

async function check(value: EvalCheck, overrides: Partial<CheckContext> = {}): Promise<CheckOutcome> {
  return evaluateCheck(value, context(overrides));
}

describe("file checks", () => {
  it("file_contains", async () => {
    expect((await check({ type: "file_contains", path: "src/sum.js", text: "i < count" })).result.passed).toBe(true);
    const missingText = await check({ type: "file_contains", path: "src/sum.js", text: "i <= count" });
    expect(missingText.result).toMatchObject({ passed: false, name: "file_contains src/sum.js" });
    const missingFile = await check({ type: "file_contains", path: "src/nope.js", text: "x" });
    expect(missingFile.result).toMatchObject({ passed: false, detail: "src/nope.js does not exist" });
    expect((await check({ type: "file_contains", path: "src", text: "x" })).result.detail).toMatch(/not a regular file/);
  });

  it("file_matches", async () => {
    expect((await check({ type: "file_matches", path: "src/sum.js", pattern: "i\\s*<\\s*count" })).result.passed).toBe(true);
    expect((await check({ type: "file_matches", path: "src/sum.js", pattern: "<=" })).result.passed).toBe(false);
    expect((await check({ type: "file_matches", path: "README.md", pattern: "^# readme$", flags: "im" })).result.passed).toBe(true);
    expect((await check({ type: "file_matches", path: "missing.md", pattern: "." })).result.passed).toBe(false);
  });

  it("file_absent", async () => {
    expect((await check({ type: "file_absent", path: "dist/out.js" })).result.passed).toBe(true);
    expect((await check({ type: "file_absent", path: "README.md" })).result).toMatchObject({ passed: false, detail: "README.md exists" });
  });

  it("file_unchanged", async () => {
    expect((await check({ type: "file_unchanged", path: "README.md" })).result.passed).toBe(true);
    expect((await check({ type: "file_unchanged", path: "src/sum.js" })).result).toMatchObject({
      passed: false,
      detail: "src/sum.js was changed",
    });
    rmSync(path.join(taskDir, "README.md"));
    expect((await check({ type: "file_unchanged", path: "README.md" })).result.passed).toBe(false);
    expect((await check({ type: "file_unchanged", path: "README.md" }, { fixtureDir: null })).result.passed).toBe(false);
    expect((await check({ type: "file_unchanged", path: "not-in-fixture.md" })).result.detail).toMatch(/not in the fixture/);
  });

  it("never reads outside the task folder, even when a suite check bypasses the schema", async () => {
    write(root, "secret.txt", "secret");
    const escaped = await check({ type: "file_contains", path: "../secret.txt", text: "secret" });
    expect(escaped.result.passed).toBe(false);
    expect(escaped.result.detail).toMatch(/escapes the workspace/);
    expect((await check({ type: "file_absent", path: "../secret.txt" })).result.passed).toBe(false);
  });
});

describe("tool and transcript checks", () => {
  it("tool_called counts successful calls", async () => {
    expect((await check({ type: "tool_called", name: "read_file" })).result).toMatchObject({
      passed: true,
      detail: "read_file succeeded 1 time (2 calls, needed 1)",
    });
    expect((await check({ type: "tool_called", name: "read_file", minTimes: 2 })).result.passed).toBe(false);
    expect((await check({ type: "tool_called", name: "calculator" })).result.passed).toBe(false);
    expect((await check({ type: "tool_called", name: "list_files" })).result.passed).toBe(false);
  });

  it("tool_not_called counts any attempt", async () => {
    expect((await check({ type: "tool_not_called", name: "write_file" })).result.passed).toBe(true);
    expect((await check({ type: "tool_not_called", name: "calculator" })).result).toMatchObject({
      passed: false,
      detail: "calculator was called 1 time",
    });
  });

  it("answer_contains", async () => {
    expect((await check({ type: "answer_contains", text: "8417" })).result.passed).toBe(true);
    expect((await check({ type: "answer_contains", text: "THE PORT" })).result.passed).toBe(true);
    expect((await check({ type: "answer_contains", text: "THE PORT", caseSensitive: true })).result.passed).toBe(false);
    expect((await check({ type: "answer_contains", text: "8080" })).result.passed).toBe(false);
  });

  it("answer_matches", async () => {
    expect((await check({ type: "answer_matches", pattern: "\\b8417\\b" })).result.passed).toBe(true);
    expect((await check({ type: "answer_matches", pattern: "^8417$" })).result.passed).toBe(false);
  });

  it("answer_json", async () => {
    const json = (answer: string) => ({ transcript: transcript({ answer }) });
    const keys: EvalCheck = { type: "answer_json", requiredKeys: ["language", "stable"] };
    expect((await check(keys, json(' {"language": "JavaScript", "stable": true}\n'))).result.passed).toBe(true);
    expect((await check(keys, json('{"language": "JavaScript"}'))).result).toMatchObject({ passed: false, detail: "Missing keys: stable" });
    expect((await check(keys, json('Sure! {"language": "JavaScript", "stable": true}'))).result.passed).toBe(false);
    expect((await check(keys, json('["language", "stable"]'))).result.detail).toMatch(/not an object/);
    expect((await check(keys, json("```json\n{}\n```"))).result.passed).toBe(false);
  });

  it("max_steps", async () => {
    expect((await check({ type: "max_steps", max: 3 })).result.passed).toBe(true);
    expect((await check({ type: "max_steps", max: 2 })).result).toMatchObject({ passed: false, detail: "3 assistant turns (limit 2)" });
  });

  it("no_invalid_tool_calls", async () => {
    expect((await check({ type: "no_invalid_tool_calls" })).result).toMatchObject({ passed: false, detail: "1 invalid of 3 tool calls" });
    expect((await check({ type: "no_invalid_tool_calls" }, { transcript: transcript({ invalidToolCalls: 0 }) })).result.passed).toBe(true);
  });

  it("builds a transcript from stored messages and counts invalid calls", () => {
    const at = "2026-01-01T00:00:00.000Z";
    const messages: StoredMessage[] = [
      { id: "u", seq: 1, role: "user", content: "Go", createdAt: at },
      {
        id: "a1",
        seq: 2,
        role: "assistant",
        content: "",
        reasoning: "",
        toolCalls: [
          { id: "c1", name: "nope", arguments: "{}" },
          { id: "c2", name: "read_file", arguments: "{" },
          { id: "c3", name: "read_file", arguments: '{"x":1}' },
          { id: "c4", name: "read_file", arguments: '{"path":"a"}' },
          { id: "c5", name: "edit_file", arguments: "{}" },
        ],
        model: "m",
        interrupted: false,
        createdAt: at,
      },
      { id: "t1", seq: 3, role: "tool", toolCallId: "c1", content: 'Unknown tool "nope". Use only the tools you were given.', status: "error", createdAt: at },
      { id: "t2", seq: 4, role: "tool", toolCallId: "c2", content: "The arguments were not valid JSON. Send a single JSON object.", status: "error", createdAt: at },
      { id: "t3", seq: 5, role: "tool", toolCallId: "c3", content: "Invalid arguments: ✖ Unrecognized key", status: "error", createdAt: at },
      { id: "t4", seq: 6, role: "tool", toolCallId: "c4", content: "1\thello", status: "ok", createdAt: at },
      { id: "a2", seq: 7, role: "assistant", content: "Done.", reasoning: "", toolCalls: [], model: "fallback", interrupted: false, createdAt: at },
    ];
    const result = transcriptOf(messages);
    expect(result).toMatchObject({ answer: "Done.", steps: 2, invalidToolCalls: 3, models: ["m", "fallback"] });
    expect(result.calls).toHaveLength(5);
    expect(result.calls[4]).toMatchObject({ name: "edit_file", status: null, output: null });
    expect(isInvalidToolResult("Not found: a")).toBe(false);
  });
});

describe("regex safety", () => {
  it("times out a catastrophic pattern instead of hanging", () => {
    expect(regexTest("^(a+)+$", undefined, `${"a".repeat(40)}!`)).toBeNull();
    expect(regexTest("a+", "i", "AAA")).toBe(true);
  });
});

describe("judge checks", () => {
  const judge = { provider: "ollama" as const, model: "judge" };
  const reply = (content: string) => vi.fn<CompletionFn>(async () => ({ content, reasoning: "", toolCalls: [], finishReason: "stop" }));

  it("is skipped and not counted without a judge model", async () => {
    const outcome = await check({ type: "judge", rubric: "Correct port" });
    expect(outcome).toMatchObject({ counted: false, result: { name: "judge (skipped)", passed: false } });
  });

  it("grades with the judge's score and passes at the threshold", async () => {
    const complete = reply('{"score": 0.8, "reason": "Names the right port."}');
    const outcome = await check({ type: "judge", rubric: "Correct port" }, { judge, judgeComplete: complete });
    expect(outcome).toMatchObject({ counted: true, credit: 0.8, result: { name: "judge", passed: true } });
    expect(outcome.result.detail).toContain("Names the right port.");
    const request = complete.mock.calls[0][0];
    expect(request).toMatchObject({ provider: "ollama", model: "judge", tools: [], temperature: 0 });
    expect(request.messages[1].content).toContain("Correct port");
    expect(request.messages[1].content).toContain("The port is 8417.");
    expect(request.messages[1].content).toContain("read_file (2), calculator (1)");

    const low = await check({ type: "judge", rubric: "Correct port", minScore: 0.9 }, { judge, judgeComplete: complete });
    expect(low).toMatchObject({ counted: true, credit: 0.8, result: { passed: false } });
  });

  it("fails closed on malformed or failed judge replies", async () => {
    const malformed = await check({ type: "judge", rubric: "r" }, { judge, judgeComplete: reply("Looks good to me!") });
    expect(malformed).toMatchObject({ counted: true, credit: 0, result: { passed: false } });
    expect(malformed.result.detail).toMatch(/not JSON with a score/);
    const outOfRange = await check({ type: "judge", rubric: "r" }, { judge, judgeComplete: reply('{"score": 7}') });
    expect(outOfRange.result.passed).toBe(false);
    const failing = vi.fn<CompletionFn>(async () => {
      throw new Error("connection refused");
    });
    const failed = await check({ type: "judge", rubric: "r" }, { judge, judgeComplete: failing });
    expect(failed.result).toMatchObject({ passed: false, detail: "The judge model failed: connection refused" });
  });

  it("parses judge replies defensively", () => {
    expect(parseJudgeReply('{"score": 1, "reason": "ok"}')).toEqual({ score: 1, reason: "ok" });
    expect(parseJudgeReply('```json\n{"score": 0.5, "reason": "half"}\n```')).toEqual({ score: 0.5, reason: "half" });
    expect(parseJudgeReply('<think>hmm</think>Grade: {"score": "0.25", "reason": "weak"} done')).toEqual({ score: 0.25, reason: "weak" });
    expect(parseJudgeReply('{"score": 0}')).toEqual({ score: 0, reason: "" });
    expect(parseJudgeReply("score: 1")).toBeNull();
    expect(parseJudgeReply('{"score": -0.1}')).toBeNull();
    expect(parseJudgeReply('{"score": "high"}')).toBeNull();
    expect(parseJudgeReply('{"reason": "no score"}')).toBeNull();
    expect(parseJudgeReply("[1]")).toBeNull();
  });
});

describe("scoring", () => {
  const item = (passed: boolean, counted = true, credit = passed ? 1 : 0): CheckOutcome => ({
    result: { name: "c", passed, detail: "" },
    counted,
    credit,
  });

  it("divides credit by counted checks and passes only when every counted check passes", () => {
    expect(scoreOutcomes([item(true), item(true), item(false, false)])).toEqual({ score: 1, passed: true, counted: 2 });
    expect(scoreOutcomes([item(true), item(false), item(true), item(true)])).toEqual({ score: 0.75, passed: false, counted: 4 });
    expect(scoreOutcomes([item(true), item(true, true, 0.8)])).toEqual({ score: 0.9, passed: true, counted: 2 });
    expect(scoreOutcomes([item(false, false)])).toEqual({ score: 0, passed: false, counted: 0 });
  });
});
