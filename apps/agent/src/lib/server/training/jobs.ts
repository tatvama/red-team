import "server-only";
import type { DatabaseSync } from "node:sqlite";
import { database } from "../db";

// In-process registry for background training jobs (evaluation runs and distillation jobs).
// Each lane runs one job at a time; later jobs wait as `queued`. Kept on globalThis so dev hot
// reloads share it. Jobs live only in this process: after a restart their rows are marked failed.

export type JobLane = "eval" | "distill";
export const RESTART_ERROR = "Interrupted by a server restart";

const TABLES: Record<JobLane, string> = { eval: "eval_runs", distill: "distill_jobs" };

type Entry = {
  id: string;
  lane: JobLane;
  state: "queued" | "running";
  controller: AbortController;
  run: (signal: AbortSignal) => Promise<void>;
  done: Promise<void>;
  settle: () => void;
};

type Registry = {
  /** Insertion order is queue order. */
  entries: Map<string, Entry>;
  running: Map<JobLane, string>;
  /** Connections already checked for jobs cut off by a restart. */
  recovered: WeakSet<DatabaseSync>;
};

const store = globalThis as unknown as { tatvamTrainingJobs?: Registry };
const registry = (): Registry =>
  (store.tatvamTrainingJobs ??= { entries: new Map(), running: new Map(), recovered: new WeakSet() });

/**
 * On first use of a database connection, rows still `queued` or `running` that this process does
 * not own were cut off by a restart (or crash): mark them failed. Idempotent.
 */
export function recoverInterruptedJobs(): void {
  const db = database();
  const { recovered, entries } = registry();
  if (recovered.has(db)) return;
  const owned = [...entries.keys()];
  const exclude = owned.length ? ` AND id NOT IN (${owned.map(() => "?").join(", ")})` : "";
  const time = new Date().toISOString();
  for (const table of Object.values(TABLES))
    db.prepare(
      `UPDATE ${table} SET status = 'failed', error = ?, finished_at = ? WHERE status IN ('queued', 'running')${exclude}`,
    ).run(RESTART_ERROR, time, ...owned);
  recovered.add(db);
}

/** Last-resort bookkeeping when a job's own error handling failed. */
function markCrashed(lane: JobLane, id: string, error: unknown) {
  try {
    const message = `The job stopped unexpectedly: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500);
    database()
      .prepare(`UPDATE ${TABLES[lane]} SET status = 'failed', error = ?, finished_at = ? WHERE id = ? AND status IN ('queued', 'running')`)
      .run(message, new Date().toISOString(), id);
  } catch {
    // The database is unavailable; recovery marks the row on the next start.
  }
}

function pump(lane: JobLane) {
  const reg = registry();
  if (reg.running.has(lane)) return;
  const next = [...reg.entries.values()].find((entry) => entry.lane === lane && entry.state === "queued");
  if (!next) return;
  next.state = "running";
  reg.running.set(lane, next.id);
  let work: Promise<void>;
  try {
    // Runs synchronously up to its first await, so the job can mark itself running before this returns.
    work = next.run(next.controller.signal);
  } catch (error) {
    work = Promise.reject(error);
  }
  work
    .catch((error: unknown) => markCrashed(lane, next.id, error))
    .finally(() => {
      reg.entries.delete(next.id);
      reg.running.delete(lane);
      next.settle();
      pump(lane);
    });
}

/** Queues a job; it starts right away when nothing else runs in its lane. */
export function enqueueJob(lane: JobLane, id: string, run: (signal: AbortSignal) => Promise<void>): void {
  let settle = () => {};
  const done = new Promise<void>((resolve) => {
    settle = resolve;
  });
  registry().entries.set(id, { id, lane, state: "queued", controller: new AbortController(), run, done, settle });
  pump(lane);
}

/**
 * Aborts a job and marks its row `cancelled` at once. A queued job is dropped without running (and
 * finished now); a running job stops at its next check of the signal and records its own finish
 * time. Returns what the job was doing, or null when this process does not have it.
 */
export function cancelJob(id: string): "queued" | "running" | null {
  const reg = registry();
  const entry = reg.entries.get(id);
  if (!entry) return null;
  entry.controller.abort();
  const table = TABLES[entry.lane];
  if (entry.state === "running") {
    database().prepare(`UPDATE ${table} SET status = 'cancelled' WHERE id = ? AND status IN ('queued', 'running')`).run(id);
    return "running";
  }
  reg.entries.delete(id);
  database()
    .prepare(`UPDATE ${table} SET status = 'cancelled', finished_at = ? WHERE id = ? AND status IN ('queued', 'running')`)
    .run(new Date().toISOString(), id);
  entry.settle();
  return "queued";
}

export function jobState(id: string): "queued" | "running" | null {
  return registry().entries.get(id)?.state ?? null;
}

/** Resolves when the job has finished (immediately when it is not active). */
export function waitForJob(id: string): Promise<void> {
  return registry().entries.get(id)?.done ?? Promise.resolve();
}

/** Cancels every job and waits until they have stopped (tests and shutdown). */
export async function drainJobs(): Promise<void> {
  const entries = [...registry().entries.values()];
  for (const entry of entries) cancelJob(entry.id);
  await Promise.all(entries.map((entry) => entry.done));
}
