// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as db from "../db";
import { cancelJob, drainJobs, enqueueJob, jobState, recoverInterruptedJobs, RESTART_ERROR, waitForJob } from "./jobs";
import { gate } from "./test-helpers";

let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), "tatvam-jobs-"));
  vi.stubEnv("DATA_DIR", dataDir);
});
afterEach(async () => {
  await drainJobs();
  db.closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

const time = "2026-01-01T00:00:00.000Z";
function insertDistill(status: string): string {
  const id = crypto.randomUUID();
  db.database()
    .prepare("INSERT INTO distill_jobs (id, teacher, request, status, total, started_at) VALUES (?, '{}', '{}', ?, 1, ?)")
    .run(id, status, time);
  return id;
}
const row = (id: string) => db.database().prepare("SELECT status, error, finished_at FROM distill_jobs WHERE id = ?").get(id) as {
  status: string;
  error: string | null;
  finished_at: string | null;
};

describe("job registry", () => {
  it("runs one job per lane, lets lanes run side by side and starts the next queued job", async () => {
    const hold = gate();
    const order: string[] = [];
    const work = (name: string, wait?: Promise<void>) => async () => {
      order.push(`start ${name}`);
      await wait;
      order.push(`end ${name}`);
    };
    enqueueJob("eval", "e1", work("e1", hold.promise));
    enqueueJob("eval", "e2", work("e2"));
    enqueueJob("distill", "d1", work("d1"));
    expect([jobState("e1"), jobState("e2"), jobState("d1")]).toEqual(["running", "queued", "running"]);
    await waitForJob("d1");
    expect(order).toEqual(["start e1", "start d1", "end d1"]);
    hold.open();
    await waitForJob("e2");
    expect(order).toEqual(["start e1", "start d1", "end d1", "end e1", "start e2", "end e2"]);
    expect(jobState("e1")).toBeNull();
  });

  it("cancels queued jobs without running them and aborts running ones", async () => {
    const running = insertDistill("running");
    const queued = insertDistill("queued");
    let sawAbort = false;
    enqueueJob("distill", running, async (signal) => {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      sawAbort = signal.aborted;
    });
    const neverRuns = vi.fn(async () => {});
    enqueueJob("distill", queued, neverRuns);

    expect(cancelJob(queued)).toBe("queued");
    expect(row(queued)).toMatchObject({ status: "cancelled" });
    expect(row(queued).finished_at).not.toBeNull();

    expect(cancelJob(running)).toBe("running");
    expect(row(running)).toMatchObject({ status: "cancelled", finished_at: null });
    await waitForJob(running);
    expect(sawAbort).toBe(true);
    expect(neverRuns).not.toHaveBeenCalled();
    expect(cancelJob(running)).toBeNull();
    expect(cancelJob("unknown")).toBeNull();
  });

  it("marks a job failed when it crashes without recording its own outcome", async () => {
    const id = insertDistill("running");
    enqueueJob("distill", id, async () => {
      throw new Error("boom");
    });
    await waitForJob(id);
    expect(row(id)).toMatchObject({ status: "failed", error: "The job stopped unexpectedly: boom" });
  });

  it("recovers interrupted rows once per connection and spares jobs this process owns", async () => {
    const orphan = insertDistill("running");
    const owned = insertDistill("running");
    const hold = gate();
    enqueueJob("distill", owned, () => hold.promise);
    recoverInterruptedJobs();
    expect(row(orphan)).toMatchObject({ status: "failed", error: RESTART_ERROR });
    expect(row(owned)).toMatchObject({ status: "running", error: null });

    // Later rows on the same connection are not touched again.
    const later = insertDistill("queued");
    recoverInterruptedJobs();
    expect(row(later).status).toBe("queued");
    hold.open();
    await waitForJob(owned);
  });
});
