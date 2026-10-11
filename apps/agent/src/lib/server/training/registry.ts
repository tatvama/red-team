import "server-only";
import type { z } from "zod";
import {
  modelKindSchema,
  modelStatusSchema,
  providerSchema,
  type RegisteredModel,
  type registerModelSchema,
  type updateModelSchema,
} from "@/lib/contract";
import { database } from "../db";

// The model registry: base models, fine-tunes and distilled students, with where they came from
// (parent model, dataset export) and their lifecycle (candidate → active → retired). It only records
// models; which model answers is decided by the router.

export type RegisterModelRequest = z.infer<typeof registerModelSchema>;
export type UpdateModelRequest = z.infer<typeof updateModelSchema>;

export class RegistryError extends Error {
  readonly status: 400 | 404 | 409;
  constructor(message: string, status: 400 | 404 | 409) {
    super(message);
    this.status = status;
  }
}

type Row = Record<string, unknown>;
type LatestEval = NonNullable<RegisteredModel["latestEval"]>;

const evalKey = (provider: string, model: string) => `${provider}\u0000${model}`;

function parseJson(value: unknown): unknown {
  try {
    return typeof value === "string" ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}

/** The most recent completed eval run per target ("provider\0model"). */
function latestEvals(): Map<string, LatestEval> {
  const rows = database()
    .prepare(
      `SELECT id, suite_id, target, summary, finished_at FROM eval_runs
       WHERE status = 'completed' AND finished_at IS NOT NULL ORDER BY finished_at DESC, rowid DESC`,
    )
    .all() as Row[];
  const latest = new Map<string, LatestEval>();
  for (const row of rows) {
    const target = parseJson(row.target) as { provider?: unknown; model?: unknown } | null;
    if (typeof target?.provider !== "string" || typeof target.model !== "string") continue;
    const key = evalKey(target.provider, target.model);
    if (latest.has(key)) continue;
    const summary = parseJson(row.summary) as { passRate?: unknown } | null;
    const passRate = typeof summary?.passRate === "number" && Number.isFinite(summary.passRate) ? summary.passRate : 0;
    latest.set(key, { runId: String(row.id), suiteId: String(row.suite_id), passRate, finishedAt: String(row.finished_at) });
  }
  return latest;
}

function toModel(row: Row, evals: Map<string, LatestEval>): RegisteredModel {
  const provider = providerSchema.safeParse(row.provider);
  const kind = modelKindSchema.safeParse(row.kind);
  const status = modelStatusSchema.safeParse(row.status);
  return {
    id: String(row.id),
    provider: provider.success ? provider.data : "gpu",
    modelId: String(row.model_id),
    label: String(row.label),
    kind: kind.success ? kind.data : "base",
    parentId: (row.parent_id as string | null) ?? null,
    datasetExportId: (row.dataset_export_id as string | null) ?? null,
    status: status.success ? status.data : "candidate",
    notes: String(row.notes ?? ""),
    createdAt: String(row.created_at),
    latestEval: evals.get(evalKey(String(row.provider), String(row.model_id))) ?? null,
  };
}

export function listModels(): RegisteredModel[] {
  const evals = latestEvals();
  const rows = database().prepare("SELECT * FROM registered_models ORDER BY created_at DESC, rowid DESC").all() as Row[];
  return rows.map((row) => toModel(row, evals));
}

export function getModel(id: string): RegisteredModel | null {
  const row = database().prepare("SELECT * FROM registered_models WHERE id = ?").get(id) as Row | undefined;
  return row ? toModel(row, latestEvals()) : null;
}

function exists(table: "registered_models" | "dataset_exports", id: string): boolean {
  return !!database().prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id);
}

function assertUnique(provider: string, modelId: string, exceptId: string | null) {
  const row = database()
    .prepare("SELECT id FROM registered_models WHERE provider = ? AND model_id = ?")
    .get(provider, modelId) as Row | undefined;
  if (row && String(row.id) !== exceptId) throw new RegistryError("This model is already registered.", 409);
}

function assertReferences(input: { parentId: string | null; datasetExportId: string | null }, selfId: string | null) {
  if (input.parentId !== null) {
    if (input.parentId === selfId) throw new RegistryError("A model cannot be its own parent.", 400);
    if (!exists("registered_models", input.parentId)) throw new RegistryError("The parent model is not registered.", 400);
    // Walk up the chain so an update cannot create a loop (A → B → A).
    const parentOf = database().prepare("SELECT parent_id FROM registered_models WHERE id = ?");
    const seen = new Set<string>();
    for (let current: string | null = input.parentId; current && !seen.has(current); ) {
      if (current === selfId) throw new RegistryError("This parent would make a model its own ancestor.", 400);
      seen.add(current);
      const row = parentOf.get(current) as Row | undefined;
      current = (row?.parent_id as string | null | undefined) ?? null;
    }
  }
  if (input.datasetExportId !== null && !exists("dataset_exports", input.datasetExportId))
    throw new RegistryError("The dataset export does not exist.", 400);
}

const isUniqueViolation = (error: unknown) => error instanceof Error && /UNIQUE constraint failed/i.test(error.message);

/** Throws RegistryError: 409 for a duplicate provider and model, 400 for a missing parent or dataset export. */
export function registerModel(input: RegisterModelRequest): RegisteredModel {
  assertUnique(input.provider, input.modelId, null);
  assertReferences(input, null);
  const id = crypto.randomUUID();
  try {
    database()
      .prepare(
        `INSERT INTO registered_models (id, provider, model_id, label, kind, parent_id, dataset_export_id, status, notes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.provider,
        input.modelId,
        input.label,
        input.kind,
        input.parentId,
        input.datasetExportId,
        input.status,
        input.notes,
        new Date().toISOString(),
      );
  } catch (error) {
    if (isUniqueViolation(error)) throw new RegistryError("This model is already registered.", 409);
    throw error;
  }
  return getModel(id)!;
}

/** Throws RegistryError: 404 when the model is missing, plus the register errors for changed fields. */
export function updateModel(id: string, patch: UpdateModelRequest): RegisteredModel {
  const current = getModel(id);
  if (!current) throw new RegistryError("This model is not registered.", 404);
  const next = { ...current, ...patch };
  if (next.provider !== current.provider || next.modelId !== current.modelId) assertUnique(next.provider, next.modelId, id);
  if (next.parentId !== current.parentId || next.datasetExportId !== current.datasetExportId)
    assertReferences(
      {
        parentId: next.parentId !== current.parentId ? next.parentId : null,
        datasetExportId: next.datasetExportId !== current.datasetExportId ? next.datasetExportId : null,
      },
      id,
    );
  try {
    database()
      .prepare(
        `UPDATE registered_models SET provider = ?, model_id = ?, label = ?, kind = ?, parent_id = ?, dataset_export_id = ?,
           status = ?, notes = ? WHERE id = ?`,
      )
      .run(next.provider, next.modelId, next.label, next.kind, next.parentId, next.datasetExportId, next.status, next.notes, id);
  } catch (error) {
    if (isUniqueViolation(error)) throw new RegistryError("This model is already registered.", 409);
    throw error;
  }
  return getModel(id)!;
}

/** Removes the model; models derived from it keep their record but lose the parent link. */
export function deleteModel(id: string): boolean {
  const db = database();
  db.exec("BEGIN");
  try {
    db.prepare("UPDATE registered_models SET parent_id = NULL WHERE parent_id = ?").run(id);
    const removed = Number(db.prepare("DELETE FROM registered_models WHERE id = ?").run(id).changes) > 0;
    db.exec(removed ? "COMMIT" : "ROLLBACK");
    return removed;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
