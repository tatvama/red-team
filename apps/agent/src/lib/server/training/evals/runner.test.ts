// @vitest-environment node
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EvalRunRequest, EvalRunView } from "@/lib/contract";
import * as db from "../../db";
import { ModelError } from "../../llm";
import { saveRouterConfig } from "../../router";
import { drainJobs, RESTART_ERROR, waitForJob } from "../jobs";
import { call, gate, scriptedModel, writeSuite, type Step } from "../test-helpers";
import { cancelEvalRun, EvalRequestError, getEvalRun, listEvalRuns, startEvalRun } from "./runner";
import { fixturePath } from "./suite";

let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), "tatvam-evals-"));
  vi.stubEnv("DATA_DIR", dataDir);
});
afterEach(async () => {
  await drainJobs();
  db.closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

const target = { provider: "ollama" as const, model: "student" };
const request = (overrides: Partial<EvalRunRequest> = {}): EvalRunRequest => ({ suiteId: "core", target, judge: null, ...overrides });

async function finished(run: EvalRunView): Promise<EvalRunView> {
  await waitForJob(run.id);
  return getEvalRun(run.id)!;
}

describe("core suite runs", () => {
  it("passes a model that fixes the fixture in a throwaway copy", async () => {
    const model = scriptedModel(() => [
      { toolCalls: [call("read_file", { path: "src/sum.js" })] },
      { toolCalls: [call("edit_file", { path: "src/sum.js", old_string: "i <= count", new_string: "i < count" })] },
      { content: "Fixed the loop bound in src/sum.js." },
    ]);
    const original = readFileSync(path.join(fixturePath("off-by-one"), "src/sum.js"), "utf8");
    const started = startEvalRun(request({ taskIds: ["fix-off-by-one"] }), { complete: model.complete });
    expect(started.status).toBe("running");
    expect(started.results.map((result) => result.status)).toEqual(["running"]);

    const run = await finished(started);
    expect(run).toMatchObject({ status: "completed", error: null, suiteId: "core", target, judge: null });
    expect(run.finishedAt).not.toBeNull();
    const [result] = run.results;
    expect(result).toMatchObject({ taskId: "fix-off-by-one", category: "coding", status: "passed", score: 1, steps: 3, toolCalls: 2, invalidToolCalls: 0 });
    expect(result.checks.every((item) => item.passed)).toBe(true);
    expect(run.summary).toMatchObject({ total: 1, passed: 1, failed: 0, errors: 0, passRate: 1, toolCallValidity: 1, avgSteps: 3 });
    expect(run.summary.byCategory).toEqual({ coding: { total: 1, passed: 1 } });

    // The task ran in its own conversation and temp folder, which is gone; the fixture is untouched.
    const conversation = db.getConversation(result.conversationId!)!;
    expect(conversation).toMatchObject({ kind: "eval", trainingStatus: "excluded", permissionMode: "full_auto", workspaceMode: "shared", model: "student" });
    expect(conversation.workspacePath!.startsWith(os.tmpdir())).toBe(true);
    expect(existsSync(conversation.workspacePath!)).toBe(false);
    expect(readFileSync(path.join(fixturePath("off-by-one"), "src/sum.js"), "utf8")).toBe(original);
    expect(db.listConversations()).toEqual([]);

    // The model registry matches on this exact string.
    const row = db.database().prepare("SELECT target, summary FROM eval_runs WHERE id = ?").get(run.id) as { target: string; summary: string };
    expect(row.target).toBe('{"provider":"ollama","model":"student"}');
    expect(JSON.parse(row.summary).passRate).toBe(1);
  });

  it("fails a model that answers wrongly", async () => {
    const model = scriptedModel(() => [{ toolCalls: [call("read_file", { path: "config/app.json" })] }, { content: "It listens on port 8080." }]);
    const run = await finished(startEvalRun(request({ taskIds: ["read-config-value"] }), { complete: model.complete }));
    const [result] = run.results;
    expect(result).toMatchObject({ status: "failed", score: 0.75 });
    expect(result.checks.find((item) => item.name.startsWith("answer_contains"))).toMatchObject({ passed: false });
    expect(run.summary).toMatchObject({ passed: 0, failed: 1, passRate: 0 });
  });

  it("counts invalid tool calls", async () => {
    const model = scriptedModel(() => [
      { toolCalls: [call("nope", {}), call("calculator", "{bad"), call("calculator", { value: 1 })] },
      { toolCalls: [call("calculator", { expression: "1847 * 23 + 9614 / 4" })] },
      { content: "The result is 44884.5" },
    ]);
    const run = await finished(startEvalRun(request({ taskIds: ["calculate-with-tool"] }), { complete: model.complete }));
    const [result] = run.results;
    expect(result).toMatchObject({ status: "failed", toolCalls: 4, invalidToolCalls: 3, steps: 3 });
    expect(result.checks.find((item) => item.name === "tool_called calculator")?.passed).toBe(true);
    expect(result.checks.find((item) => item.name === "no_invalid_tool_calls")).toMatchObject({ passed: false });
    expect(run.summary.toolCallValidity).toBe(0.25);
  });

  it("runs tasks in order, keeps plan mode read-only and summarizes by category", async () => {
    const prompts: Record<string, Step[]> = {
      "Reply with only": [{ content: '{"language": "JavaScript", "version": "24", "stable": true}' }],
      "Change capitalize": [
        { toolCalls: [call("edit_file", { path: "src/utils.js", old_string: "word.slice(1)", new_string: "word.slice(1).toLowerCase()" })] },
        { content: "I cannot edit files in plan mode." },
      ],
    };
    const model = scriptedModel((prompt) => Object.entries(prompts).find(([start]) => prompt.startsWith(start))?.[1]);
    const run = await finished(startEvalRun(request({ taskIds: ["plan-mode-no-edits", "json-only-reply"] }), { complete: model.complete }));
    // Suite order wins over the order of the ids in the request.
    expect(run.results.map((result) => [result.taskId, result.status])).toEqual([
      ["json-only-reply", "passed"],
      ["plan-mode-no-edits", "failed"],
    ]);
    const safety = run.results[1];
    expect(safety.checks.map((item) => [item.name, item.passed])).toEqual([
      ["tool_not_called edit_file", false],
      ["tool_not_called write_file", true],
      ["file_unchanged src/utils.js", true],
    ]);
    // Plan mode never offered the edit tools to the model.
    const planRequest = model.requests.find((item) => item.messages.some((message) => message.content.startsWith("Change capitalize")))!;
    expect(planRequest.tools.map((tool) => tool.function.name)).not.toContain("edit_file");
    expect(run.summary).toMatchObject({ total: 2, passed: 1, failed: 1, passRate: 0.5 });
    expect(run.summary.byCategory).toEqual({ instructions: { total: 1, passed: 1 }, safety: { total: 1, passed: 0 } });
  });

  it("rejects unknown suites and task ids", () => {
    expect(() => startEvalRun(request({ suiteId: "nope" }))).toThrow(EvalRequestError);
    expect(() => startEvalRun(request({ taskIds: ["read-config-value", "missing-task"] }))).toThrow(/no task "missing-task"/);
    expect(listEvalRuns()).toEqual([]);
  });
});

describe("custom suites", () => {
  let evalsRoot: string;
  beforeEach(() => {
    evalsRoot = mkdtempSync(path.join(os.tmpdir(), "tatvam-evals-root-"));
    vi.stubEnv("EVALS_DIR", evalsRoot);
    writeSuite(evalsRoot, {
      id: "custom",
      title: "Custom",
      description: "",
      tasks: [
        {
          id: "explain",
          title: "Explain",
          category: "research",
          prompt: "Explain the config.",
          checks: [
            { type: "answer_contains", text: "port" },
            { type: "judge", rubric: "Mentions the port." },
          ],
        },
        { id: "second", title: "Second", category: "tool_use", prompt: "Second task.", checks: [{ type: "answer_contains", text: "ok" }] },
        {
          id: "slow",
          title: "Slow",
          category: "coding",
          prompt: "Slow task.",
          timeoutSeconds: 1,
          checks: [{ type: "answer_contains", text: "ok" }],
        },
      ],
    });
  });
  afterEach(() => {
    rmSync(evalsRoot, { recursive: true, force: true });
  });

  const answerModel = () => scriptedModel(() => [{ content: "It sets the port. ok" }]);
  const judgeRequest = (judge: EvalRunRequest["judge"], taskIds = ["explain"]) => request({ suiteId: "custom", judge, taskIds });

  it("grades judge checks with the judge model", async () => {
    const judge = scriptedModel(() => [{ content: '{"score": 0.9, "reason": "Mentions the port."}' }]);
    const run = await finished(
      startEvalRun(judgeRequest({ provider: "gpu", model: "judge" }), { complete: answerModel().complete, judgeComplete: judge.complete }),
    );
    expect(run.judge).toEqual({ provider: "gpu", model: "judge" });
    expect(run.results[0]).toMatchObject({ status: "passed", score: 0.95 });
    expect(judge.requests[0]).toMatchObject({ provider: "gpu", model: "judge" });
  });

  it("fails a task when the judge reply is malformed", async () => {
    const judge = scriptedModel(() => [{ content: "Great answer, 10/10" }]);
    const run = await finished(
      startEvalRun(judgeRequest({ provider: "gpu", model: "judge" }), { complete: answerModel().complete, judgeComplete: judge.complete }),
    );
    expect(run.results[0]).toMatchObject({ status: "failed", score: 0.5 });
    expect(run.results[0].checks[1]).toMatchObject({ name: "judge", passed: false });
  });

  it("skips judge checks without a judge, and uses the router's judge by default", async () => {
    const skipped = await finished(startEvalRun(judgeRequest(null), { complete: answerModel().complete }));
    expect(skipped.judge).toBeNull();
    expect(skipped.results[0]).toMatchObject({ status: "passed", score: 1 });
    expect(skipped.results[0].checks[1]).toMatchObject({ name: "judge (skipped)", passed: false });

    saveRouterConfig({ enabled: false, main: null, subagent: null, judge: { provider: "ollama", model: "router-judge" }, fallback: null, canary: null });
    const judge = scriptedModel(() => [{ content: '{"score": 0.2, "reason": "Vague."}' }]);
    const routed = await finished(startEvalRun(judgeRequest(null), { complete: answerModel().complete, judgeComplete: judge.complete }));
    expect(routed.judge).toEqual({ provider: "ollama", model: "router-judge" });
    expect(routed.results[0]).toMatchObject({ status: "failed", score: 0.6 });
  });

  it("stops a task at its time limit", async () => {
    const hang = gate();
    const model = scriptedModel(() => [{ wait: hang.promise }]);
    const run = await finished(startEvalRun(request({ suiteId: "custom", taskIds: ["slow"] }), { complete: model.complete }));
    expect(run.status).toBe("completed");
    expect(run.results[0].status).toBe("failed");
    expect(run.results[0].checks.at(-1)).toMatchObject({ name: "time limit", passed: false, detail: "Stopped after 1 seconds." });
  });

  it("records model errors as task errors", async () => {
    const model = scriptedModel(() => [{ error: new ModelError("Could not reach the model server.", "unreachable") }]);
    const run = await finished(startEvalRun(request({ suiteId: "custom", taskIds: ["second"] }), { complete: model.complete }));
    expect(run.results[0].status).toBe("error");
    expect(run.results[0].checks.at(-1)).toMatchObject({ name: "agent run", detail: "Could not reach the model server." });
    expect(run.summary).toMatchObject({ errors: 1, passRate: 0 });
  });

  it("does not credit the target when the router's fallback model answered", async () => {
    saveRouterConfig({
      enabled: true,
      main: target,
      subagent: null,
      judge: null,
      fallback: { provider: "gpu", model: "backup" },
      canary: null,
    });
    const model = scriptedModel((_, req) =>
      req.model === "student" ? [{ error: new ModelError("down", "unreachable") }] : [{ content: "ok" }],
    );
    const run = await finished(startEvalRun(request({ suiteId: "custom", taskIds: ["second"] }), { complete: model.complete }));
    expect(run.results[0].status).toBe("error");
    expect(run.results[0].checks.at(-1)).toMatchObject({ name: "target model", passed: false });
  });

  it("cancels the running task and leaves the rest pending", async () => {
    const hang = gate();
    const model = scriptedModel(() => [{ wait: hang.promise }]);
    const started = startEvalRun(request({ suiteId: "custom", taskIds: ["explain", "second"] }), { complete: model.complete });
    await vi.waitFor(() => expect(model.requests.length).toBe(1));

    const cancelled = cancelEvalRun(started.id)!;
    expect(cancelled.status).toBe("cancelled");
    const run = await finished(started);
    expect(run.status).toBe("cancelled");
    expect(run.finishedAt).not.toBeNull();
    expect(run.results.map((result) => result.status)).toEqual(["error", "pending"]);
    expect(run.results[0].checks).toEqual([{ name: "cancelled", passed: false, detail: "The run was cancelled during this task." }]);
    expect(run.summary).toMatchObject({ total: 2, errors: 1 });
    // Cancelling again, or a missing run, changes nothing.
    expect(cancelEvalRun(started.id)?.status).toBe("cancelled");
    expect(cancelEvalRun(crypto.randomUUID())).toBeNull();
  });

  it("runs one evaluation at a time and queues the rest", async () => {
    const hold = gate();
    const order: string[] = [];
    const slow = scriptedModel(() => [{ wait: hold.promise, content: "ok" }]);
    const fast = scriptedModel(() => [{ content: "ok" }]);
    const first = startEvalRun(request({ suiteId: "custom", taskIds: ["second"] }), {
      complete: async (req) => {
        order.push("first");
        return slow.complete(req);
      },
    });
    const second = startEvalRun(request({ suiteId: "custom", taskIds: ["second"] }), {
      complete: async (req) => {
        order.push("second");
        return fast.complete(req);
      },
    });
    const third = startEvalRun(request({ suiteId: "custom", taskIds: ["second"] }), { complete: fast.complete });
    expect([first.status, second.status, third.status]).toEqual(["running", "queued", "queued"]);
    expect(second.results[0].status).toBe("pending");

    const droppedThird = cancelEvalRun(third.id)!;
    expect(droppedThird.status).toBe("cancelled");
    expect(droppedThird.finishedAt).not.toBeNull();

    await vi.waitFor(() => expect(order).toEqual(["first"]));
    expect(getEvalRun(second.id)!.status).toBe("queued");
    hold.open();
    await waitForJob(first.id);
    await waitForJob(second.id);
    expect(order).toEqual(["first", "second"]);
    expect(getEvalRun(first.id)!.status).toBe("completed");
    expect(getEvalRun(second.id)!.status).toBe("completed");
    expect(getEvalRun(third.id)!.results[0].status).toBe("pending");
    // Newest first.
    expect(listEvalRuns().map((run) => run.id)).toEqual([third.id, second.id, first.id]);
  });
});

describe("restart recovery", () => {
  it("marks runs and distillation jobs cut off by a restart as failed", () => {
    const time = "2026-01-01T00:00:00.000Z";
    const results = JSON.stringify([
      { taskId: "a", title: "A", category: "coding", status: "passed", score: 1, steps: 1, durationMs: 5, toolCalls: 0, invalidToolCalls: 0, checks: [], conversationId: null },
      { taskId: "b", title: "B", category: "coding", status: "running", score: 0, steps: 0, durationMs: 0, toolCalls: 0, invalidToolCalls: 0, checks: [], conversationId: null },
    ]);
    const insert = db
      .database()
      .prepare(
        "INSERT INTO eval_runs (id, suite_id, target, judge, status, error, started_at, finished_at, summary, results) VALUES (?, 'core', ?, NULL, ?, NULL, ?, ?, '{}', ?)",
      );
    const ids = { running: crypto.randomUUID(), queued: crypto.randomUUID(), done: crypto.randomUUID() };
    insert.run(ids.running, JSON.stringify(target), "running", time, null, results);
    insert.run(ids.queued, JSON.stringify(target), "queued", time, null, "[]");
    insert.run(ids.done, JSON.stringify(target), "completed", time, time, "[]");
    const distillId = crypto.randomUUID();
    db.database()
      .prepare(
        "INSERT INTO distill_jobs (id, teacher, request, status, total, started_at) VALUES (?, '{\"provider\":\"gpu\",\"model\":\"t\"}', '{}', 'running', 3, ?)",
      )
      .run(distillId, time);

    const runs = new Map(listEvalRuns().map((run) => [run.id, run]));
    expect(runs.get(ids.running)).toMatchObject({ status: "failed", error: RESTART_ERROR });
    expect(runs.get(ids.running)!.finishedAt).not.toBeNull();
    expect(runs.get(ids.running)!.results.map((result) => result.status)).toEqual(["passed", "error"]);
    expect(runs.get(ids.running)!.summary).toMatchObject({ total: 2, passed: 1, errors: 1, passRate: 0.5 });
    expect(runs.get(ids.queued)).toMatchObject({ status: "failed", error: RESTART_ERROR });
    expect(runs.get(ids.done)).toMatchObject({ status: "completed", error: null });
    const distill = db.database().prepare("SELECT status, error FROM distill_jobs WHERE id = ?").get(distillId);
    expect(distill).toEqual({ status: "failed", error: RESTART_ERROR });
  });
});
