// Test-only helpers for the kit and registry tests: a dataset export laid out the way the exporter
// writes it (DATA_DIR/training/exports/<id>/ plus a dataset_exports row), and a valid kit request.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { FinetuneKitRequest } from "@/lib/contract";
import { dataDir } from "../config";
import { database } from "../db";

const sftRecord = {
  messages: [
    { role: "system", content: "You are Tatvam." },
    { role: "user", content: "What port does the service use?" },
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"config.json"}' } }],
    },
    { role: "tool", tool_call_id: "call_1", content: '{"port": 8080}' },
    { role: "assistant", content: "It listens on port 8080." },
  ],
  tools: [
    {
      type: "function",
      function: { name: "read_file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
    },
  ],
};
const dpoRecord = {
  prompt: [{ role: "user", content: "Say hello" }],
  chosen: [{ role: "assistant", content: "Hello!" }],
  rejected: [{ role: "assistant", content: "Go away." }],
};

const jsonl = (records: object[]) => records.map((record) => JSON.stringify(record)).join("\n") + (records.length ? "\n" : "");

export type SeedOptions = {
  /** Write dpo.jsonl with this many pairs (0 writes an empty file, undefined writes none). */
  dpoPairs?: number;
  /** Write sft_eval.jsonl (default true). */
  evalSplit?: boolean;
  /** Training examples in sft_train.jsonl (default 3). */
  trainExamples?: number;
  kinds?: string[];
  /** Skip creating the folder (row only). */
  noFiles?: boolean;
};

/** Creates an export folder and row; returns the export id. */
export function seedExport(options: SeedOptions = {}): string {
  const id = crypto.randomUUID();
  const folder = path.join(dataDir(), "training", "exports", id);
  const contents: Record<string, { text: string; records: number | null }> = {
    "sft_train.jsonl": { text: jsonl(Array(options.trainExamples ?? 3).fill(sftRecord)), records: options.trainExamples ?? 3 },
    "manifest.json": { text: JSON.stringify({ id, format: "openai-chat" }), records: null },
    "README.md": { text: "# Export\n", records: null },
  };
  if (options.evalSplit ?? true) contents["sft_eval.jsonl"] = { text: jsonl([sftRecord]), records: 1 };
  if (options.dpoPairs !== undefined)
    contents["dpo.jsonl"] = { text: jsonl(Array(options.dpoPairs).fill(dpoRecord)), records: options.dpoPairs };
  if (!options.noFiles) {
    mkdirSync(folder, { recursive: true });
    for (const [name, file] of Object.entries(contents)) writeFileSync(path.join(folder, name), file.text);
  }
  const files = Object.entries(contents).map(([name, file]) => ({
    name,
    bytes: Buffer.byteLength(file.text),
    records: file.records ?? 0,
  }));
  const request = {
    statuses: ["approved"],
    kinds: options.kinds ?? ["chat"],
    requirePositiveFeedback: false,
    redactPii: true,
    evalFraction: 0.1,
    systemPrompt: "agent",
  };
  database()
    .prepare("INSERT INTO dataset_exports (id, created_at, request, stats, files) VALUES (?, ?, ?, ?, ?)")
    .run(id, new Date().toISOString(), JSON.stringify(request), JSON.stringify({ conversations: 3 }), JSON.stringify(files));
  return id;
}

export function kitRequest(exportId: string, overrides: Partial<FinetuneKitRequest> = {}): FinetuneKitRequest {
  return {
    exportId,
    baseModel: "Qwen/Qwen3-8B",
    method: "sft_lora",
    framework: "trl",
    hyperparameters: {
      epochs: 2.5,
      learningRate: 0.00007,
      loraRank: 24,
      loraAlpha: 48,
      maxSeqLength: 6144,
      batchSize: 2,
      gradientAccumulation: 6,
    },
    outputName: "tatvam-coder-v2",
    ...overrides,
  };
}
