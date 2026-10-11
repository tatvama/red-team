// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as cancelRun } from "@/app/api/evals/runs/[id]/cancel/route";
import { GET as getRun } from "@/app/api/evals/runs/[id]/route";
import { GET as listRuns, POST as startRun } from "@/app/api/evals/runs/route";
import { GET as listSuites } from "@/app/api/evals/suites/route";
import type { EvalRunView, EvalSuiteView } from "@/lib/contract";
import { closeDb } from "@/lib/server/db";
import { drainJobs, waitForJob } from "@/lib/server/training/jobs";

// Through the real route handlers, with the model server replaced by scripted SSE.

let dir: string;
let replies: string[];
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "tatvam-eval-routes-"));
  vi.stubEnv("DATA_DIR", dir);
  replies = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      const body = replies.shift();
      if (body === undefined) throw new Error("unexpected model call");
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    }),
  );
});
afterEach(async () => {
  await drainJobs();
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

const sse = (...deltas: object[]) =>
  deltas.map((delta) => `data: ${JSON.stringify({ choices: [{ index: 0, delta }] })}\n\n`).join("") + "data: [DONE]\n\n";
const base = "http://127.0.0.1:3000";
const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(base + url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const valid = { suiteId: "core", target: { provider: "ollama", model: "qwen3" }, judge: null, taskIds: ["json-only-reply"] };

describe("evaluation routes", () => {
  it("lists suites without their prompts or checks", async () => {
    const response = await listSuites(new Request(base + "/api/evals/suites"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const { suites } = (await response.json()) as { suites: EvalSuiteView[] };
    const core = suites.find((suite) => suite.id === "core")!;
    expect(core.tasks.find((task) => task.id === "json-only-reply")).toEqual({
      id: "json-only-reply",
      title: "Reply with JSON only",
      category: "instructions",
    });
  });

  it("starts a run, shows it while it runs and after it finishes", async () => {
    replies.push(sse({ content: '{"language": "JavaScript", ' }, { content: '"version": "24", "stable": true}' }));
    const response = await startRun(post("/api/evals/runs", valid));
    expect(response.status).toBe(200);
    const started = (await response.json()) as EvalRunView;
    expect(started).toMatchObject({ suiteId: "core", target: valid.target, judge: null, summary: { total: 1 } });
    expect(["queued", "running"]).toContain(started.status);

    await waitForJob(started.id);
    const detail = await getRun(new Request(base), params(started.id));
    expect(detail.status).toBe(200);
    const run = (await detail.json()) as EvalRunView;
    expect(run).toMatchObject({ status: "completed", summary: { passed: 1, passRate: 1 } });
    expect(run.results[0]).toMatchObject({ taskId: "json-only-reply", status: "passed", score: 1 });

    const list = (await (await listRuns(new Request(base + "/api/evals/runs"))).json()) as { runs: EvalRunView[] };
    expect(list.runs.map((item) => item.id)).toEqual([started.id]);

    // Cancelling a finished run leaves it as it was.
    const cancelled = await cancelRun(post(`/api/evals/runs/${started.id}/cancel`, {}), params(started.id));
    expect(cancelled.status).toBe(200);
    expect(((await cancelled.json()) as EvalRunView).status).toBe("completed");
  });

  it("cancels a running run", async () => {
    // The model server never answers until the request is aborted.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))),
      ),
    );
    const started = (await (await startRun(post("/api/evals/runs", valid))).json()) as EvalRunView;
    const response = await cancelRun(post(`/api/evals/runs/${started.id}/cancel`, {}), params(started.id));
    expect(response.status).toBe(200);
    expect(((await response.json()) as EvalRunView).status).toBe("cancelled");
    await waitForJob(started.id);
    const run = (await (await getRun(new Request(base), params(started.id))).json()) as EvalRunView;
    expect(run.status).toBe("cancelled");
    expect(run.finishedAt).not.toBeNull();
  });

  it.each([
    ["a body that is not JSON", "{nope"],
    ["a missing target", { suiteId: "core", judge: null }],
    ["an extra field", { ...valid, shell: "ls" }],
    ["a bad suite id", { ...valid, suiteId: "../core" }],
    ["an unknown provider", { ...valid, target: { provider: "openai", model: "gpt" } }],
    ["an empty task list", { ...valid, taskIds: [] }],
  ])("rejects %s", async (_, body) => {
    const response = await startRun(post("/api/evals/runs", body));
    expect(response.status).toBe(400);
  });

  it("rejects unknown suites and task ids with a message", async () => {
    const suite = await startRun(post("/api/evals/runs", { ...valid, suiteId: "missing" }));
    expect(suite.status).toBe(400);
    expect(((await suite.json()) as { error: string }).error).toBe('There is no evaluation suite "missing".');
    const task = await startRun(post("/api/evals/runs", { ...valid, taskIds: ["no-such-task"] }));
    expect(task.status).toBe(400);
    expect(((await task.json()) as { error: string }).error).toMatch(/no task "no-such-task"/);
    const list = (await (await listRuns(new Request(base + "/api/evals/runs"))).json()) as { runs: EvalRunView[] };
    expect(list.runs).toEqual([]);
  });

  it("returns 404 for missing runs", async () => {
    for (const id of [crypto.randomUUID(), "not-a-uuid"]) {
      expect((await getRun(new Request(base), params(id))).status).toBe(404);
      expect((await cancelRun(post(`/api/evals/runs/${id}/cancel`, {}), params(id))).status).toBe(404);
    }
  });

  it("refuses cross-site requests", async () => {
    const response = await startRun(post("/api/evals/runs", valid, { origin: "https://evil.example" }));
    expect(response.status).toBe(403);
    const list = await listRuns(new Request("http://evil.example/api/evals/runs"));
    expect(list.status).toBe(403);
  });
});
