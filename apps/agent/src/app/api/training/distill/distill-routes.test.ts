// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as cancelJob } from "@/app/api/training/distill/[id]/cancel/route";
import { GET as getJob } from "@/app/api/training/distill/[id]/route";
import { GET as listJobs, POST as startJob } from "@/app/api/training/distill/route";
import type { DistillJobView } from "@/lib/contract";
import { closeDb, getConversation } from "@/lib/server/db";
import { drainJobs, waitForJob } from "@/lib/server/training/jobs";

let dir: string;
let replies: string[];
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "tatvam-distill-routes-"));
  vi.stubEnv("DATA_DIR", dir);
  vi.stubEnv("GPU_BASE_URL", "https://gpu.example.test/v1");
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
const teacher = { provider: "gpu", model: "big-teacher" };
const valid = { teacher, source: { type: "prompts", prompts: ["Explain HTTP caching"] }, autoApprove: true };

describe("distillation routes", () => {
  it("starts a job and reports it until it finishes", async () => {
    replies.push(sse({ content: "Caching stores responses " }, { content: "so they can be reused." }));
    const response = await startJob(post("/api/training/distill", valid));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const started = (await response.json()) as DistillJobView;
    expect(started).toMatchObject({ teacher, total: 1 });

    await waitForJob(started.id);
    const job = (await (await getJob(new Request(base), params(started.id))).json()) as DistillJobView;
    expect(job).toMatchObject({ status: "completed", completed: 1, failed: 0 });
    expect(getConversation(job.conversationIds[0])).toMatchObject({ kind: "distill", trainingStatus: "approved", model: "big-teacher" });

    const list = (await (await listJobs(new Request(base + "/api/training/distill"))).json()) as { jobs: DistillJobView[] };
    expect(list.jobs.map((item) => item.id)).toEqual([started.id]);
    const cancelled = await cancelJob(post(`/api/training/distill/${started.id}/cancel`, {}), params(started.id));
    expect(((await cancelled.json()) as DistillJobView).status).toBe("completed");
  });

  it.each([
    ["a body that is not JSON", "{"],
    ["no prompts", { ...valid, source: { type: "prompts", prompts: [] } }],
    ["a blank prompt", { ...valid, source: { type: "prompts", prompts: ["   "] } }],
    ["an unknown source", { ...valid, source: { type: "files", path: "/etc" } }],
    ["a history limit of zero", { ...valid, source: { type: "history", limit: 0 } }],
    ["a missing autoApprove", { teacher, source: valid.source }],
    ["an extra field", { ...valid, permissionMode: "full_auto" }],
  ])("rejects %s", async (_, body) => {
    expect((await startJob(post("/api/training/distill", body))).status).toBe(400);
  });

  it("explains when there is no history to distill", async () => {
    const response = await startJob(post("/api/training/distill", { ...valid, source: { type: "history", limit: 10 } }));
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toMatch(/no chat conversations/);
  });

  it("returns 404 for missing jobs", async () => {
    for (const id of [crypto.randomUUID(), "nope"]) {
      expect((await getJob(new Request(base), params(id))).status).toBe(404);
      expect((await cancelJob(post(`/api/training/distill/${id}/cancel`, {}), params(id))).status).toBe(404);
    }
  });

  it("refuses cross-site requests", async () => {
    expect((await startJob(post("/api/training/distill", valid, { origin: "https://evil.example" }))).status).toBe(403);
  });
});
