// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDb, database } from "../db";
import { seedExport } from "./kit-fixtures";
import { deleteModel, getModel, listModels, registerModel, RegistryError, updateModel, type RegisterModelRequest } from "./registry";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "tatvam-registry-"));
  vi.stubEnv("DATA_DIR", dir);
});
afterEach(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

const base: RegisterModelRequest = {
  provider: "gpu",
  modelId: "Qwen/Qwen3-8B",
  label: "Qwen3 8B",
  kind: "base",
  parentId: null,
  datasetExportId: null,
  status: "active",
  notes: "",
};

function expectRegistryError(work: () => unknown, status: number) {
  try {
    work();
  } catch (error) {
    expect(error).toBeInstanceOf(RegistryError);
    expect((error as RegistryError).status).toBe(status);
    return;
  }
  throw new Error("expected a RegistryError");
}

function addEvalRun(input: { target: object | string; status?: string; finishedAt: string | null; passRate?: number; suiteId?: string }) {
  const id = crypto.randomUUID();
  database()
    .prepare(
      `INSERT INTO eval_runs (id, suite_id, target, judge, status, error, started_at, finished_at, summary, results)
       VALUES (?, ?, ?, NULL, ?, NULL, ?, ?, ?, '[]')`,
    )
    .run(
      id,
      input.suiteId ?? "core",
      typeof input.target === "string" ? input.target : JSON.stringify(input.target),
      input.status ?? "completed",
      "2026-10-01T00:00:00.000Z",
      input.finishedAt,
      JSON.stringify({ total: 10, passed: 0, failed: 0, errors: 0, passRate: input.passRate ?? 0.5 }),
    );
  return id;
}

describe("model registry", () => {
  it("registers, lists, updates and deletes models", () => {
    const parent = registerModel(base);
    expect(parent).toMatchObject({ ...base, latestEval: null });
    expect(parent.id).toMatch(/^[0-9a-f-]{36}$/);

    const exportId = seedExport();
    const child = registerModel({
      ...base,
      modelId: "tatvam-coder-v1",
      label: "Tatvam coder v1",
      kind: "finetune",
      parentId: parent.id,
      datasetExportId: exportId,
      status: "candidate",
      notes: "First fine-tune.",
    });
    expect(child).toMatchObject({ parentId: parent.id, datasetExportId: exportId, status: "candidate" });
    expect(listModels().map((model) => model.id)).toEqual([child.id, parent.id]); // newest first

    expect(updateModel(child.id, { status: "active", notes: "Promoted." })).toMatchObject({ status: "active", notes: "Promoted.", label: "Tatvam coder v1" });
    expect(updateModel(child.id, {})).toMatchObject({ status: "active" });
    expect(getModel(child.id)?.status).toBe("active");

    // Deleting the parent keeps the child and clears its parent link.
    expect(deleteModel(parent.id)).toBe(true);
    expect(deleteModel(parent.id)).toBe(false);
    expect(getModel(parent.id)).toBeNull();
    expect(getModel(child.id)?.parentId).toBeNull();
  });

  it("refuses a duplicate provider and model, but allows the same model on another provider", () => {
    registerModel(base);
    expectRegistryError(() => registerModel({ ...base, label: "Again" }), 409);
    const local = registerModel({ ...base, provider: "ollama" });
    expect(local.provider).toBe("ollama");
    const other = registerModel({ ...base, modelId: "other" });
    expectRegistryError(() => updateModel(other.id, { modelId: base.modelId }), 409);
    expect(updateModel(other.id, { modelId: "renamed" }).modelId).toBe("renamed");
  });

  it("refuses references to models or exports that do not exist", () => {
    expectRegistryError(() => registerModel({ ...base, parentId: crypto.randomUUID() }), 400);
    expectRegistryError(() => registerModel({ ...base, datasetExportId: crypto.randomUUID() }), 400);
    expect(listModels()).toEqual([]);

    const a = registerModel(base);
    const b = registerModel({ ...base, modelId: "b", parentId: a.id });
    expectRegistryError(() => updateModel(a.id, { parentId: a.id }), 400);
    expectRegistryError(() => updateModel(a.id, { parentId: b.id }), 400);
    expectRegistryError(() => updateModel(a.id, { datasetExportId: crypto.randomUUID() }), 400);
    expect(getModel(a.id)?.parentId).toBeNull();
  });

  it("returns 404 for updates to a missing model", () => {
    expectRegistryError(() => updateModel(crypto.randomUUID(), { status: "retired" }), 404);
  });

  it("reports the latest completed eval run for the provider and model", () => {
    const model = registerModel({ ...base, modelId: "tatvam-coder-v1" });
    const target = { provider: "gpu", model: "tatvam-coder-v1" };
    addEvalRun({ target, finishedAt: "2026-10-02T00:00:00.000Z", passRate: 0.4 });
    const latest = addEvalRun({ target: { model: "tatvam-coder-v1", provider: "gpu" }, finishedAt: "2026-10-05T00:00:00.000Z", passRate: 0.8, suiteId: "coding" });
    addEvalRun({ target, finishedAt: "2026-10-03T00:00:00.000Z", passRate: 0.6 });
    addEvalRun({ target, status: "running", finishedAt: null, passRate: 0.1 });
    addEvalRun({ target, status: "failed", finishedAt: "2026-10-09T00:00:00.000Z", passRate: 0.2 });
    addEvalRun({ target, status: "cancelled", finishedAt: "2026-10-09T00:00:00.000Z", passRate: 0.2 });
    addEvalRun({ target: { provider: "ollama", model: "tatvam-coder-v1" }, finishedAt: "2026-10-08T00:00:00.000Z", passRate: 0.9 });
    addEvalRun({ target: { provider: "gpu", model: "another" }, finishedAt: "2026-10-08T00:00:00.000Z", passRate: 0.9 });
    addEvalRun({ target: "not json", finishedAt: "2026-10-09T00:00:00.000Z" });

    const expected = { runId: latest, suiteId: "coding", passRate: 0.8, finishedAt: "2026-10-05T00:00:00.000Z" };
    expect(getModel(model.id)?.latestEval).toEqual(expected);
    expect(listModels()[0].latestEval).toEqual(expected);
    expect(registerModel({ ...base, modelId: "never-evaluated" }).latestEval).toBeNull();
  });
});
