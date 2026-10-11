import "server-only";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  modelRefSchema,
  type AgentEvent,
  type EvalCategory,
  type EvalCheckResult,
  type EvalRunRequest,
  type EvalRunView,
  type EvalTaskResult,
  type JobStatus,
  type ModelRef,
} from "@/lib/contract";
import { finishRun, runAgent, tryStartRun } from "../../agent";
import { commandConfig } from "../../config";
import * as db from "../../db";
import { streamCompletion, type CompletionFn } from "../../llm";
import { getRouterConfig } from "../../router";
import { builtinTools } from "../../tools";
import type { ToolDefinition } from "../../tools/types";
import { cancelJob, enqueueJob, recoverInterruptedJobs } from "../jobs";
import { evaluateChecks, scoreOutcomes, transcriptOf, type CheckOutcome } from "./checks";
import { fixturePath, getSuite, type EvalSuite, type EvalTask } from "./suite";

/**
 * Injectable model calls (tests). `tools` defaults to `evalTools()`.
 */
export type EvalDeps = { complete?: CompletionFn; judgeComplete?: CompletionFn; tools?: ToolDefinition[] };

/**
 * Tools an unattended evaluation task may use. Tasks run in full_auto inside a throwaway copy of
 * the fixture, which only protects files, so everything that can act outside that folder is left
 * out: MCP tools, network tools (suites must be reproducible offline), memory tools (an eval must
 * not edit the user's memories) and shell commands unless they run in the Docker sandbox.
 */
export function evalTools(): ToolDefinition[] {
  const sandboxed = commandConfig().runner === "docker";
  const excluded = new Set(["web_search", "web_fetch", "save_memory", "forget_memory"]);
  return builtinTools.filter((tool) => !excluded.has(tool.name) && (tool.name !== "run_command" || sandboxed));
}

/** A request naming an unknown suite or task (HTTP 400). */
export class EvalRequestError extends Error {}

type Row = Record<string, unknown>;
type RunState = Omit<EvalRunView, "summary">;

const now = () => new Date().toISOString();

function parseJson<T>(value: unknown, fallback: T): T {
  try {
    return typeof value === "string" ? (JSON.parse(value) as T) : fallback;
  } catch {
    return fallback;
  }
}

/** The model registry matches `eval_runs.target` against exactly this string. */
export function modelRefJson(ref: ModelRef): string {
  return JSON.stringify({ provider: ref.provider, model: ref.model });
}

function parseModelRef(value: unknown): ModelRef | null {
  const parsed = modelRefSchema.safeParse(parseJson<unknown>(value, null));
  return parsed.success ? parsed.data : null;
}

export function summarize(results: EvalTaskResult[]): EvalRunView["summary"] {
  const finished = results.filter((result) => result.status === "passed" || result.status === "failed" || result.status === "error");
  const passed = finished.filter((result) => result.status === "passed").length;
  const toolCalls = finished.reduce((sum, result) => sum + result.toolCalls, 0);
  const invalid = finished.reduce((sum, result) => sum + result.invalidToolCalls, 0);
  const average = (pick: (result: EvalTaskResult) => number) =>
    finished.length ? Math.round((finished.reduce((sum, result) => sum + pick(result), 0) / finished.length) * 100) / 100 : 0;
  const byCategory: Partial<Record<EvalCategory, { total: number; passed: number }>> = {};
  for (const result of results) {
    const entry = (byCategory[result.category] ??= { total: 0, passed: 0 });
    entry.total++;
    if (result.status === "passed") entry.passed++;
  }
  return {
    total: results.length,
    passed,
    failed: finished.filter((result) => result.status === "failed").length,
    errors: finished.filter((result) => result.status === "error").length,
    passRate: finished.length ? Math.round((passed / finished.length) * 1000) / 1000 : 0,
    toolCallValidity: toolCalls ? Math.round(((toolCalls - invalid) / toolCalls) * 1000) / 1000 : 1,
    avgSteps: average((result) => result.steps),
    avgDurationMs: Math.round(average((result) => result.durationMs)),
    byCategory,
  };
}

function toView(row: Row): EvalRunView {
  const status = String(row.status) as JobStatus;
  const stored = parseJson<EvalTaskResult[]>(row.results, []);
  // A run that ended (cancelled, or cut off by a restart) cannot still be working on a task.
  const results =
    status === "queued" || status === "running"
      ? stored
      : stored.map((result) => (result.status === "running" ? { ...result, status: "error" as const } : result));
  return {
    id: String(row.id),
    suiteId: String(row.suite_id),
    target: parseModelRef(row.target) ?? { provider: "ollama", model: "unknown" },
    judge: parseModelRef(row.judge),
    status,
    error: (row.error as string | null) ?? null,
    startedAt: String(row.started_at),
    finishedAt: (row.finished_at as string | null) ?? null,
    summary: summarize(results),
    results,
  };
}

export function listEvalRuns(limit = 200): EvalRunView[] {
  recoverInterruptedJobs();
  const rows = db
    .database()
    .prepare("SELECT * FROM eval_runs ORDER BY started_at DESC, rowid DESC LIMIT ?")
    .all(limit) as Row[];
  return rows.map(toView);
}

export function getEvalRun(id: string): EvalRunView | null {
  recoverInterruptedJobs();
  const row = db.database().prepare("SELECT * FROM eval_runs WHERE id = ?").get(id) as Row | undefined;
  return row ? toView(row) : null;
}

/** Cancels a queued or running run. Null when the run does not exist. */
export function cancelEvalRun(id: string): EvalRunView | null {
  if (!getEvalRun(id)) return null;
  cancelJob(id);
  return getEvalRun(id);
}

function insertRun(state: RunState) {
  db.database()
    .prepare(
      `INSERT INTO eval_runs (id, suite_id, target, judge, status, error, started_at, finished_at, summary, results)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      state.id,
      state.suiteId,
      modelRefJson(state.target),
      state.judge ? modelRefJson(state.judge) : null,
      state.status,
      state.error,
      state.startedAt,
      state.finishedAt,
      JSON.stringify(summarize(state.results)),
      JSON.stringify(state.results),
    );
}

function persist(state: RunState, signal: AbortSignal) {
  // Once cancelled, the row stays cancelled even if this run is still unwinding.
  const status: JobStatus = signal.aborted && state.status !== "failed" ? "cancelled" : state.status;
  db.database()
    .prepare("UPDATE eval_runs SET status = ?, error = ?, finished_at = ?, summary = ?, results = ? WHERE id = ?")
    .run(status, state.error, state.finishedAt, JSON.stringify(summarize(state.results)), JSON.stringify(state.results), state.id);
}

function selectTasks(suite: EvalSuite, taskIds: string[] | undefined): EvalTask[] {
  if (!taskIds) return suite.tasks;
  const unknown = taskIds.filter((id) => !suite.tasks.some((task) => task.id === id));
  if (unknown.length) throw new EvalRequestError(`Suite "${suite.id}" has no task ${unknown.map((id) => `"${id}"`).join(", ")}.`);
  const wanted = new Set(taskIds);
  return suite.tasks.filter((task) => wanted.has(task.id));
}

const pendingResult = (task: EvalTask): EvalTaskResult => ({
  taskId: task.id,
  title: task.title,
  category: task.category,
  status: "pending",
  score: 0,
  steps: 0,
  durationMs: 0,
  toolCalls: 0,
  invalidToolCalls: 0,
  checks: [],
  conversationId: null,
});

/**
 * Queues an evaluation run and returns it. Tasks run one after another, each in a fresh copy of
 * its fixture; progress is saved after every task. Throws EvalRequestError for unknown ids.
 */
export function startEvalRun(request: EvalRunRequest, deps: EvalDeps = {}): EvalRunView {
  recoverInterruptedJobs();
  const suite = getSuite(request.suiteId);
  if (!suite) throw new EvalRequestError(`There is no evaluation suite "${request.suiteId}".`);
  const tasks = selectTasks(suite, request.taskIds);
  const state: RunState = {
    id: crypto.randomUUID(),
    suiteId: suite.id,
    target: { provider: request.target.provider, model: request.target.model },
    judge: request.judge ?? getRouterConfig().judge,
    status: "queued",
    error: null,
    startedAt: now(),
    finishedAt: null,
    results: tasks.map(pendingResult),
  };
  insertRun(state);
  enqueueJob("eval", state.id, (signal) => executeRun(state, suite, tasks, deps, signal));
  return getEvalRun(state.id)!;
}

async function executeRun(state: RunState, suite: EvalSuite, tasks: EvalTask[], deps: EvalDeps, signal: AbortSignal) {
  state.status = "running";
  persist(state, signal);
  try {
    for (const [index, task] of tasks.entries()) {
      if (signal.aborted) break;
      state.results[index] = { ...state.results[index], status: "running" };
      persist(state, signal);
      state.results[index] = await runTask(state, suite, task, deps, signal);
      persist(state, signal);
    }
    state.status = signal.aborted ? "cancelled" : "completed";
  } catch (error) {
    state.status = signal.aborted ? "cancelled" : "failed";
    state.error = error instanceof Error ? error.message.slice(0, 500) : "The evaluation stopped unexpectedly.";
  }
  state.finishedAt = now();
  persist(state, signal);
}

const failing = (name: string, detail: string): CheckOutcome => ({ result: { name, passed: false, detail }, counted: true, credit: 0 });

const cancelledResult = (result: EvalTaskResult, started: number): EvalTaskResult => ({
  ...result,
  status: "error",
  score: 0,
  durationMs: Date.now() - started,
  checks: [{ name: "cancelled", passed: false, detail: "The run was cancelled during this task." }],
});

async function runTask(state: RunState, suite: EvalSuite, task: EvalTask, deps: EvalDeps, jobSignal: AbortSignal): Promise<EvalTaskResult> {
  const started = Date.now();
  const base = pendingResult(task);
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, task.timeoutSeconds * 1000);
  const relay = () => controller.abort();
  jobSignal.addEventListener("abort", relay, { once: true });
  let taskDir: string | null = null;
  let conversationId: string | null = null;
  try {
    taskDir = await fs.mkdtemp(path.join(os.tmpdir(), "tatvam-eval-"));
    const fixtureDir = task.fixture ? fixturePath(task.fixture) : null;
    if (fixtureDir) await fs.cp(fixtureDir, taskDir, { recursive: true });

    const conversation = db.createConversation({
      title: `Eval ${suite.id}: ${task.title}`.slice(0, 120),
      provider: state.target.provider,
      model: state.target.model,
      permissionMode: task.permissionMode,
      kind: "eval",
      // Training on evaluation tasks would contaminate the benchmark.
      trainingStatus: "excluded",
    });
    conversationId = conversation.id;
    db.setConversationWorkspace(conversation.id, { mode: "shared", path: taskDir, branch: null, baseBranch: null, baseCommit: null });
    db.appendMessage(conversation.id, { role: "user", content: task.prompt });

    const run: { done: Extract<AgentEvent, { type: "done" }>["reason"] | null; error: string | null } = { done: null, error: null };
    if (!tryStartRun(conversation.id)) throw new Error("The task conversation is already running.");
    try {
      await runAgent({
        conversationId: conversation.id,
        provider: state.target.provider,
        model: state.target.model,
        permissionMode: task.permissionMode,
        signal: controller.signal,
        emit: (event) => {
          if (event.type === "done") run.done = event.reason;
          if (event.type === "error") run.error ??= event.message;
        },
        deps: { complete: deps.complete ?? streamCompletion, tools: deps.tools ?? evalTools() },
      });
    } finally {
      finishRun(conversation.id);
    }
    clearTimeout(timer);

    const transcript = transcriptOf(db.listMessages(conversation.id));
    const measured = {
      ...base,
      steps: transcript.steps,
      toolCalls: transcript.calls.length,
      invalidToolCalls: transcript.invalidToolCalls,
      conversationId: conversation.id,
    };
    if (jobSignal.aborted) return cancelledResult(measured, started);

    const outcomes = await evaluateChecks(task.checks, {
      taskDir,
      fixtureDir,
      prompt: task.prompt,
      transcript,
      judge: state.judge,
      judgeComplete: deps.judgeComplete ?? deps.complete ?? streamCompletion,
      signal: jobSignal,
    });
    if (jobSignal.aborted) return cancelledResult(measured, started);
    let errored = false;
    if (timedOut) outcomes.push(failing("time limit", `Stopped after ${task.timeoutSeconds} seconds.`));
    else if (run.done === "max_steps") outcomes.push(failing("step limit", run.error ?? "The agent hit its step limit."));
    else if (run.done === null && run.error) {
      errored = true;
      outcomes.push(failing("agent run", run.error));
    }
    const others = transcript.models.filter((model) => model !== state.target.model);
    if (others.length) {
      // The router's fallback answered, so this result would not measure the target model.
      errored = true;
      outcomes.push(failing("target model", `Replies came from ${others.join(", ")} instead of ${state.target.model}.`));
    }
    const score = scoreOutcomes(outcomes);
    const checks: EvalCheckResult[] = outcomes.map((item) => item.result);
    if (!score.counted)
      checks.push({ name: "graded", passed: false, detail: "No check could be counted, so the task was not graded." });
    return {
      ...measured,
      status: errored || !score.counted ? "error" : score.passed ? "passed" : "failed",
      score: score.score,
      durationMs: Date.now() - started,
      checks,
    };
  } catch (error) {
    if (jobSignal.aborted) return cancelledResult({ ...base, conversationId }, started);
    return {
      ...base,
      status: "error",
      durationMs: Date.now() - started,
      conversationId,
      checks: [
        {
          name: "harness",
          passed: false,
          detail: `The task could not run: ${error instanceof Error ? error.message.slice(0, 300) : "unknown error"}`,
        },
      ],
    };
  } finally {
    clearTimeout(timer);
    jobSignal.removeEventListener("abort", relay);
    if (taskDir) await fs.rm(taskDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }
}
