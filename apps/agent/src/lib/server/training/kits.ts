import "server-only";
import { constants, lstatSync, type Stats } from "node:fs";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { finetuneKitRequestSchema, type FinetuneKitRequest, type FinetuneKitView } from "@/lib/contract";
import { dataDir } from "../config";
import { database } from "../db";
import { renderKit, type KitDataFile } from "./kit-templates";

// Fine-tuning kits: a folder with the dataset, a trainer (TRL script or Axolotl config), merge and
// serve scripts and step-by-step instructions, to copy to a GPU server. Tatvam never runs them.

export class KitError extends Error {
  readonly status: 400 | 404;
  constructor(message: string, status: 400 | 404) {
    super(message);
    this.status = status;
  }
}

/** Files taken from a dataset export, in this order. README.md stays behind: the kit has its own. */
const DATASET_FILES = ["sft_train.jsonl", "sft_eval.jsonl", "dpo.jsonl", "manifest.json"] as const;

type Row = Record<string, unknown>;

const exportFolder = (exportId: string) => path.join(dataDir(), "training", "exports", exportId);
export const kitDir = (kitId: string) => path.join(dataDir(), "training", "kits", kitId);

function parseJson(value: unknown): unknown {
  try {
    return typeof value === "string" ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}

function regularFile(file: string): Stats | null {
  try {
    const stat = lstatSync(file);
    return stat.isFile() ? stat : null;
  } catch {
    return null;
  }
}

type ExportInfo = { id: string; kinds: string[]; files: { name: string; records: number | null }[] };

function readExport(id: string): ExportInfo | null {
  const row = database().prepare("SELECT id, request, files FROM dataset_exports WHERE id = ?").get(id) as Row | undefined;
  if (!row) return null;
  const request = parseJson(row.request) as { kinds?: unknown } | null;
  const files = parseJson(row.files);
  return {
    id: String(row.id),
    kinds: Array.isArray(request?.kinds) ? request.kinds.map(String) : [],
    files: Array.isArray(files)
      ? files.flatMap((file: { name?: unknown; records?: unknown }) =>
          typeof file?.name === "string"
            ? [{ name: file.name, records: typeof file.records === "number" ? file.records : null }]
            : [],
        )
      : [],
  };
}

/** The dataset files present on disk for an export, with record counts from its row. */
function exportDataFiles(info: ExportInfo): KitDataFile[] {
  const folder = exportFolder(info.id);
  return DATASET_FILES.flatMap((name) => {
    const stat = regularFile(path.join(folder, name));
    if (!stat) return [];
    return [{ name, bytes: stat.size, records: info.files.find((file) => file.name === name)?.records ?? null }];
  });
}

const usable = (files: KitDataFile[], name: string) =>
  files.some((file) => file.name === name && file.bytes > 0 && file.records !== 0);

/** The registry entry for the base model, when exactly one registered model has that id. */
function registeredParent(baseModel: string): string | null {
  const rows = database().prepare("SELECT id FROM registered_models WHERE model_id = ? LIMIT 2").all(baseModel) as Row[];
  return rows.length === 1 ? String(rows[0].id) : null;
}

/**
 * Rejects with KitError: 404 for an unknown export or missing files, 400 when the export lacks the
 * data the method needs. Files are copied asynchronously, since datasets can be large.
 */
export async function createKit(request: FinetuneKitRequest): Promise<FinetuneKitView> {
  const info = readExport(request.exportId);
  if (!info) throw new KitError("This dataset export no longer exists.", 404);
  const dataFiles = exportDataFiles(info);
  if (!dataFiles.length) throw new KitError("The files for this dataset export are missing. Export the dataset again.", 404);
  if (request.method === "dpo_lora" && !usable(dataFiles, "dpo.jsonl"))
    throw new KitError(
      "This export has no preference pairs (dpo.jsonl), which DPO needs. Add corrections to replies and export again, or choose an SFT method.",
      400,
    );
  if (request.method !== "dpo_lora" && !usable(dataFiles, "sft_train.jsonl"))
    throw new KitError("This export has no training examples (sft_train.jsonl). Approve more conversations and export again.", 400);

  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const folder = kitDir(id);
  const generated = renderKit({
    kitId: id,
    exportId: info.id,
    createdAt,
    request,
    dataFiles,
    parentId: registeredParent(request.baseModel),
    modelKind: info.kinds.length > 0 && info.kinds.every((kind) => kind === "distill") ? "distilled" : "finetune",
    kitPath: folder,
  });

  await mkdir(path.join(folder, "data"), { recursive: true });
  try {
    const source = exportFolder(info.id);
    for (const file of dataFiles)
      await copyFile(path.join(source, file.name), path.join(folder, "data", file.name), constants.COPYFILE_EXCL);
    for (const file of generated)
      await writeFile(path.join(folder, file.name), file.content, { encoding: "utf8", mode: file.executable ? 0o755 : 0o644 });
    const names = [...generated.map((file) => file.name), ...dataFiles.map((file) => `data/${file.name}`)];
    const files = names.map((name) => ({ name, bytes: regularFile(path.join(folder, ...name.split("/")))?.size ?? 0 }));
    const instructions = generated.find((file) => file.name === "README.md")?.content ?? "";
    database()
      .prepare("INSERT INTO finetune_kits (id, created_at, request, path, files, instructions) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, createdAt, JSON.stringify(request), folder, JSON.stringify(files), instructions);
    return { id, createdAt, request, path: folder, files, instructions };
  } catch (error) {
    await rm(folder, { recursive: true, force: true });
    throw error;
  }
}

function toView(row: Row): FinetuneKitView | null {
  const request = finetuneKitRequestSchema.safeParse(parseJson(row.request));
  if (!request.success) return null;
  const files = parseJson(row.files);
  return {
    id: String(row.id),
    createdAt: String(row.created_at),
    request: request.data,
    path: String(row.path),
    files: Array.isArray(files)
      ? files.flatMap((file: { name?: unknown; bytes?: unknown }) =>
          typeof file?.name === "string" ? [{ name: file.name, bytes: Number(file.bytes) || 0 }] : [],
        )
      : [],
    instructions: String(row.instructions),
  };
}

/** Newest first. */
export function listKits(): FinetuneKitView[] {
  const rows = database().prepare("SELECT * FROM finetune_kits ORDER BY created_at DESC, rowid DESC LIMIT 200").all() as Row[];
  return rows.flatMap((row) => toView(row) ?? []);
}

export function getKit(id: string): FinetuneKitView | null {
  const row = database().prepare("SELECT * FROM finetune_kits WHERE id = ?").get(id) as Row | undefined;
  return row ? toView(row) : null;
}

/**
 * A file of a kit, for download. Only names recorded for that kit resolve (for example "train.py" or
 * "data/sft_train.jsonl"), and the result must be a regular file inside the kit's folder.
 */
export function kitFile(kitId: string, name: string): { path: string; name: string; bytes: number } | null {
  const kit = getKit(kitId);
  const entry = kit?.files.find((file) => file.name === name);
  if (!kit || !entry) return null;
  const root = kitDir(kit.id);
  const target = path.resolve(root, ...entry.name.split("/"));
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  const stat = regularFile(target);
  return stat ? { path: target, name: entry.name, bytes: stat.size } : null;
}
