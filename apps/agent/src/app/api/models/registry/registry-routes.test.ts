// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DELETE as deleteModel, PATCH as updateModel } from "@/app/api/models/registry/[id]/route";
import { GET as listModels, POST as registerModel } from "@/app/api/models/registry/route";
import type { RegisteredModel } from "@/lib/contract";
import { closeDb, database } from "@/lib/server/db";
import { seedExport } from "@/lib/server/training/kit-fixtures";

// Model registry routes, through the real handlers against a temporary DATA_DIR.

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "tatvam-registry-routes-"));
  vi.stubEnv("DATA_DIR", dir);
});
afterEach(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

const base = "http://127.0.0.1:3000";
const send = (method: string, url: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(base + url, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const list = async () => ((await (await listModels(new Request(`${base}/api/models/registry`))).json()) as { models: RegisteredModel[] }).models;

const candidate = {
  provider: "gpu",
  modelId: "tatvam-coder-v1",
  label: "Tatvam coder v1",
  kind: "finetune",
  parentId: null,
  datasetExportId: null,
  status: "candidate",
  notes: "",
};

describe("model registry routes", () => {
  it("registers, lists, updates and deletes a model", async () => {
    const exportId = seedExport();
    const response = await registerModel(send("POST", "/api/models/registry", { ...candidate, datasetExportId: exportId }));
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const model = (await response.json()) as RegisteredModel;
    expect(model).toMatchObject({ ...candidate, datasetExportId: exportId, latestEval: null });

    database()
      .prepare(
        `INSERT INTO eval_runs (id, suite_id, target, judge, status, error, started_at, finished_at, summary, results)
         VALUES ('run-1', 'core', ?, NULL, 'completed', NULL, '2026-10-01T00:00:00.000Z', '2026-10-01T00:10:00.000Z', ?, '[]')`,
      )
      .run(JSON.stringify({ provider: "gpu", model: "tatvam-coder-v1" }), JSON.stringify({ passRate: 0.75 }));
    expect(await list()).toMatchObject([
      { id: model.id, latestEval: { runId: "run-1", suiteId: "core", passRate: 0.75, finishedAt: "2026-10-01T00:10:00.000Z" } },
    ]);

    const patched = await updateModel(send("PATCH", `/api/models/registry/${model.id}`, { status: "active", notes: "Promoted after canary." }), params(model.id));
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({ id: model.id, status: "active", notes: "Promoted after canary.", label: candidate.label });

    const removed = await deleteModel(new Request(`${base}/api/models/registry/${model.id}`, { method: "DELETE" }), params(model.id));
    expect(removed.status).toBe(204);
    expect(await list()).toEqual([]);
  });

  it("returns 409 for a duplicate and 400 for bad references or bodies", async () => {
    expect((await registerModel(send("POST", "/api/models/registry", candidate))).status).toBe(201);
    const duplicate = await registerModel(send("POST", "/api/models/registry", { ...candidate, label: "Again" }));
    expect(duplicate.status).toBe(409);
    expect(((await duplicate.json()) as { error: string }).error).toMatch(/already registered/);

    expect((await registerModel(send("POST", "/api/models/registry", { ...candidate, modelId: "x", parentId: crypto.randomUUID() }))).status).toBe(400);
    expect((await registerModel(send("POST", "/api/models/registry", { ...candidate, modelId: "y", datasetExportId: crypto.randomUUID() }))).status).toBe(400);
    for (const body of [
      { ...candidate, provider: "openai" },
      { ...candidate, status: "deployed" },
      { ...candidate, extra: 1 },
      { ...candidate, parentId: "not-a-uuid" },
      "{oops",
    ])
      expect((await registerModel(send("POST", "/api/models/registry", body))).status).toBe(400);
    expect(await list()).toHaveLength(1);

    const [model] = await list();
    expect((await updateModel(send("PATCH", `/api/models/registry/${model.id}`, { kind: "weird" }), params(model.id))).status).toBe(400);
    expect((await updateModel(send("PATCH", `/api/models/registry/${model.id}`, { parentId: model.id }), params(model.id))).status).toBe(400);
  });

  it("returns 404 when the model is missing and 403 for cross-origin callers", async () => {
    const missing = crypto.randomUUID();
    expect((await updateModel(send("PATCH", `/api/models/registry/${missing}`, { status: "retired" }), params(missing))).status).toBe(404);
    expect((await updateModel(send("PATCH", "/api/models/registry/nope", { status: "retired" }), params("nope"))).status).toBe(404);
    expect((await deleteModel(new Request(`${base}/api/models/registry/${missing}`, { method: "DELETE" }), params(missing))).status).toBe(404);
    expect((await deleteModel(new Request(`${base}/api/models/registry/nope`, { method: "DELETE" }), params("nope"))).status).toBe(404);

    expect((await registerModel(send("POST", "/api/models/registry", candidate, { origin: "https://evil.example" }))).status).toBe(403);
    expect(await list()).toEqual([]);
  });
});
