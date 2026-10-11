import "server-only";
import {
  modelRefSchema,
  type AgentEvent,
  type DistillJobView,
  type DistillRequest,
  type JobStatus,
  type ModelRef,
} from "@/lib/contract";
import { finishRun, runAgent, titleFrom, tryStartRun } from "../agent";
import * as db from "../db";
import { streamCompletion, type CompletionFn } from "../llm";
import type { ToolDefinition } from "../tools/types";
import { cancelJob, enqueueJob, recoverInterruptedJobs } from "./jobs";

// Distillation: a strong teacher model answers prompts in plan (read-only) mode in the default
// workspace. Its conversations become training examples, reviewed first unless autoApprove is set.

/** Injectable model calls (tests). Without `complete`, the configured model servers are used. */
export type DistillDeps = { complete?: CompletionFn; tools?: ToolDefinition[] };

/** A request that cannot start (HTTP 400). */
export class DistillRequestError extends Error {}

/** Longest one teacher conversation may take before it is stopped and counted as failed. */
const PROMPT_TIMEOUT_MS = 10 * 60_000;

type Row = Record<string, unknown>;
type JobState = DistillJobView;

const now = () => new Date().toISOString();

function parseJson<T>(value: unknown, fallback: T): T {
  try {
    return typeof value === "string" ? (JSON.parse(value) as T) : fallback;
  } catch {
    return fallback;
  }
}

function toView(row: Row): DistillJobView {
  const teacher = modelRefSchema.safeParse(parseJson<unknown>(row.teacher, null));
  return {
    id: String(row.id),
    teacher: teacher.success ? teacher.data : { provider: "ollama", model: "unknown" },
    status: String(row.status) as JobStatus,
    error: (row.error as string | null) ?? null,
    total: Number(row.total),
    completed: Number(row.completed),
    failed: Number(row.failed),
    conversationIds: parseJson<string[]>(row.conversation_ids, []),
    startedAt: String(row.started_at),
    finishedAt: (row.finished_at as string | null) ?? null,
  };
}

export function listDistillJobs(limit = 200): DistillJobView[] {
  recoverInterruptedJobs();
  const rows = db
    .database()
    .prepare("SELECT * FROM distill_jobs ORDER BY started_at DESC, rowid DESC LIMIT ?")
    .all(limit) as Row[];
  return rows.map(toView);
}

export function getDistillJob(id: string): DistillJobView | null {
  recoverInterruptedJobs();
  const row = db.database().prepare("SELECT * FROM distill_jobs WHERE id = ?").get(id) as Row | undefined;
  return row ? toView(row) : null;
}

/** Cancels a queued or running job. Null when the job does not exist. */
export function cancelDistillJob(id: string): DistillJobView | null {
  if (!getDistillJob(id)) return null;
  cancelJob(id);
  return getDistillJob(id);
}

/** The first user message of the most recent chat conversations, deduplicated, newest first. */
export function historyPrompts(limit: number): string[] {
  const prompts: string[] = [];
  const seen = new Set<string>();
  for (const conversation of db.listConversations()) {
    if (prompts.length >= limit) break;
    const first = db.listMessages(conversation.id).find((message) => message.role === "user");
    const prompt = first?.content.trim();
    if (!prompt || seen.has(prompt)) continue;
    seen.add(prompt);
    prompts.push(prompt);
  }
  return prompts;
}

function persist(state: JobState, signal: AbortSignal) {
  const status: JobStatus = signal.aborted && state.status !== "failed" ? "cancelled" : state.status;
  db.database()
    .prepare("UPDATE distill_jobs SET status = ?, error = ?, completed = ?, failed = ?, conversation_ids = ?, finished_at = ? WHERE id = ?")
    .run(status, state.error, state.completed, state.failed, JSON.stringify(state.conversationIds), state.finishedAt, state.id);
}

/**
 * Queues a distillation job and returns it. Prompts run one after another on the teacher model.
 * Throws DistillRequestError when there is nothing to distill.
 */
export function startDistillJob(request: DistillRequest, deps: DistillDeps = {}): DistillJobView {
  recoverInterruptedJobs();
  const prompts = request.source.type === "prompts" ? request.source.prompts : historyPrompts(request.source.limit);
  if (!prompts.length) throw new DistillRequestError("There are no chat conversations with a first message to distill yet.");
  const teacher: ModelRef = { provider: request.teacher.provider, model: request.teacher.model };
  const state: JobState = {
    id: crypto.randomUUID(),
    teacher,
    status: "queued",
    error: null,
    total: prompts.length,
    completed: 0,
    failed: 0,
    conversationIds: [],
    startedAt: now(),
    finishedAt: null,
  };
  db.database()
    .prepare(
      `INSERT INTO distill_jobs (id, teacher, request, status, error, total, completed, failed, conversation_ids, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      state.id,
      JSON.stringify({ provider: teacher.provider, model: teacher.model }),
      JSON.stringify(request),
      state.status,
      null,
      state.total,
      0,
      0,
      "[]",
      state.startedAt,
      null,
    );
  enqueueJob("distill", state.id, (signal) => executeJob(state, prompts, request.autoApprove, deps, signal));
  return getDistillJob(state.id)!;
}

async function executeJob(state: JobState, prompts: string[], autoApprove: boolean, deps: DistillDeps, signal: AbortSignal) {
  state.status = "running";
  persist(state, signal);
  try {
    for (const prompt of prompts) {
      if (signal.aborted) break;
      const outcome = await distillPrompt(state, prompt, autoApprove, deps, signal);
      if (outcome === "completed") state.completed++;
      else if (outcome === "failed") state.failed++;
      persist(state, signal);
    }
    state.status = signal.aborted ? "cancelled" : "completed";
  } catch (error) {
    state.status = signal.aborted ? "cancelled" : "failed";
    state.error = error instanceof Error ? error.message.slice(0, 500) : "The distillation stopped unexpectedly.";
  }
  state.finishedAt = now();
  persist(state, signal);
}

/**
 * One teacher conversation. "stopped" means the job was cancelled while it ran. With autoApprove,
 * the conversation is approved only once the teacher has finished, so an unfinished or wrong-model
 * conversation is never approved for training, even while the job is still running.
 */
async function distillPrompt(
  state: JobState,
  prompt: string,
  autoApprove: boolean,
  deps: DistillDeps,
  jobSignal: AbortSignal,
): Promise<"completed" | "failed" | "stopped"> {
  const conversation = db.createConversation({
    title: titleFrom(prompt),
    provider: state.teacher.provider,
    model: state.teacher.model,
    permissionMode: "plan",
    kind: "distill",
    trainingStatus: "unreviewed",
  });
  state.conversationIds.push(conversation.id);
  db.appendMessage(conversation.id, { role: "user", content: prompt });
  persist(state, jobSignal);

  const signal = AbortSignal.any([jobSignal, AbortSignal.timeout(PROMPT_TIMEOUT_MS)]);
  const run: { done: Extract<AgentEvent, { type: "done" }>["reason"] | null; error: string | null } = { done: null, error: null };
  if (!tryStartRun(conversation.id)) return "failed";
  try {
    await runAgent({
      conversationId: conversation.id,
      provider: state.teacher.provider,
      model: state.teacher.model,
      permissionMode: "plan",
      signal,
      emit: (event) => {
        if (event.type === "done") run.done = event.reason;
        if (event.type === "error") run.error ??= event.message;
      },
      deps: deps.complete || deps.tools ? { complete: deps.complete ?? streamCompletion, tools: deps.tools } : undefined,
    });
  } catch {
    run.done = null;
  } finally {
    finishRun(conversation.id);
  }

  if (jobSignal.aborted) return "stopped";
  // Only a finished reply from the teacher itself is a usable example; the router's fallback model
  // may have answered instead when the teacher was down.
  const replies = db.listMessages(conversation.id).filter((message) => message.role === "assistant");
  const fromTeacher = replies.length > 0 && replies.every((message) => message.model === state.teacher.model);
  if (run.done !== "complete" || run.error || !fromTeacher) return "failed";
  if (autoApprove) db.setTrainingStatus(conversation.id, "approved");
  return "completed";
}
