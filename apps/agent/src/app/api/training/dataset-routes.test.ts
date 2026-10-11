// @vitest-environment node
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as listQueue } from "@/app/api/training/conversations/route";
import { DELETE as deleteExport, GET as getExport } from "@/app/api/training/exports/[id]/route";
import { GET as getFile } from "@/app/api/training/exports/[id]/files/[name]/route";
import { GET as listExports, POST as createExport } from "@/app/api/training/exports/route";
import type { DatasetExportRequest, DatasetExportView, TrainingConversationView } from "@/lib/contract";
import * as db from "@/lib/server/db";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "tatvam-dataset-routes-"));
  vi.stubEnv("DATA_DIR", dir);
  vi.stubEnv("WORKSPACE_DIR", "");
});
afterEach(() => {
  db.closeDb();
  rmSync(dir, { recursive: true, force: true });
});

const base = "http://127.0.0.1:3000";
const get = (url: string, headers: Record<string, string> = {}) => new Request(base + url, { headers });
const post = (url: string, body: string, contentType = "application/json") =>
  new Request(base + url, { method: "POST", headers: { "content-type": contentType }, body });
const idParams = (id: string) => ({ params: Promise.resolve({ id }) });
const fileParams = (id: string, name: string) => ({ params: Promise.resolve({ id, name }) });

const valid: DatasetExportRequest = {
  statuses: ["approved"],
  kinds: ["chat"],
  requirePositiveFeedback: false,
  redactPii: true,
  evalFraction: 0.1,
  systemPrompt: "agent",
};

function seed() {
  const conversation = db.createConversation({
    title: "Greet",
    provider: "ollama",
    model: "qwen3",
    permissionMode: "ask",
    trainingStatus: "approved",
  });
  db.appendMessage(conversation.id, { role: "user", content: "Say hi to bob@example.com" });
  const reply = db.appendMessage(conversation.id, {
    role: "assistant",
    content: "Hi!",
    reasoning: "",
    toolCalls: [],
    model: "qwen3",
    interrupted: false,
  });
  db.saveFeedback(conversation.id, { messageId: reply.id, toolCallId: null, rating: "up", correction: null, note: null });
  return conversation.id;
}

async function exportOnce(): Promise<DatasetExportView> {
  const response = await createExport(post("/api/training/exports", JSON.stringify(valid)));
  expect(response.status).toBe(201);
  return (await response.json()) as DatasetExportView;
}

describe("GET /api/training/conversations", () => {
  it("lists the review queue with counts and validates the filters", async () => {
    const id = seed();
    const response = await listQueue(get("/api/training/conversations?status=approved&kind=chat"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as { conversations: TrainingConversationView[] };
    expect(body.conversations).toEqual([expect.objectContaining({ id, messageCount: 2, upCount: 1, trainingStatus: "approved" })]);

    const unfiltered = (await (await listQueue(get("/api/training/conversations?status=&kind="))).json()) as {
      conversations: unknown[];
    };
    expect(unfiltered.conversations).toHaveLength(1);
    const none = (await (await listQueue(get("/api/training/conversations?kind=eval"))).json()) as { conversations: unknown[] };
    expect(none.conversations).toEqual([]);

    expect((await listQueue(get("/api/training/conversations?status=great"))).status).toBe(400);
    expect((await listQueue(get("/api/training/conversations?kind=CHAT"))).status).toBe(400);
  });

  it("refuses requests from other hosts and cross-site pages", async () => {
    expect((await listQueue(new Request("http://evil.example/api/training/conversations"))).status).toBe(403);
    expect((await listQueue(get("/api/training/conversations", { origin: "http://evil.example" }))).status).toBe(403);
  });
});

describe("/api/training/exports", () => {
  it("rejects unreadable and invalid export requests", async () => {
    const bad = [
      post("/api/training/exports", JSON.stringify(valid), "text/plain"),
      post("/api/training/exports", "{not json"),
      post("/api/training/exports", JSON.stringify({ ...valid, evalFraction: 0.9 })),
      post("/api/training/exports", JSON.stringify({ ...valid, statuses: [] })),
      post("/api/training/exports", JSON.stringify({ ...valid, kinds: ["chat", "secret"] })),
      post("/api/training/exports", JSON.stringify({ ...valid, systemPrompt: "custom" })),
      post("/api/training/exports", JSON.stringify({ ...valid, path: "../../etc" })),
      post("/api/training/exports", JSON.stringify({ statuses: ["approved"] })),
    ];
    for (const request of bad) {
      const response = await createExport(request);
      expect(response.status).toBe(400);
      expect(await response.json()).toHaveProperty("error");
    }
    expect(existsSync(path.join(dir, "training", "exports"))).toBe(false);
  });

  it("creates, lists, reads and deletes an export", async () => {
    seed();
    const view = await exportOnce();
    expect(view).toMatchObject({ request: valid, stats: { conversations: 1, redactions: { email: 1 } } });
    expect(view.stats.sftTrain + view.stats.sftEval).toBe(1);

    const list = (await (await listExports(get("/api/training/exports"))).json()) as { exports: DatasetExportView[] };
    expect(list.exports).toEqual([view]);
    const one = await getExport(get(`/api/training/exports/${view.id}`), idParams(view.id));
    expect(await one.json()).toEqual(view);

    const removed = await deleteExport(new Request(`${base}/api/training/exports/${view.id}`, { method: "DELETE" }), idParams(view.id));
    expect(removed.status).toBe(204);
    expect(existsSync(path.join(dir, "training", "exports", view.id))).toBe(false);
    const again = await deleteExport(new Request(`${base}/api/training/exports/${view.id}`, { method: "DELETE" }), idParams(view.id));
    expect(again.status).toBe(404);
    expect(((await (await listExports(get("/api/training/exports"))).json()) as { exports: unknown[] }).exports).toEqual([]);
  });

  it("answers 404 for unknown and malformed export ids", async () => {
    const unknown = crypto.randomUUID();
    expect((await getExport(get(`/api/training/exports/${unknown}`), idParams(unknown))).status).toBe(404);
    expect((await getExport(get("/api/training/exports/x"), idParams("not-a-uuid"))).status).toBe(404);
    const del = (id: string) => deleteExport(new Request(`${base}/api/training/exports/${id}`, { method: "DELETE" }), idParams(id));
    expect((await del(unknown)).status).toBe(404);
    expect((await del("..")).status).toBe(404);
  });
});

describe("GET /api/training/exports/:id/files/:name", () => {
  it("downloads recorded files with the right headers", async () => {
    seed();
    const view = await exportOnce();
    const split = view.stats.sftTrain ? "sft_train.jsonl" : "sft_eval.jsonl";
    const jsonl = await getFile(get(`/api/training/exports/${view.id}/files/${split}`), fileParams(view.id, split));
    expect(jsonl.status).toBe(200);
    expect(jsonl.headers.get("content-type")).toBe("application/x-ndjson; charset=utf-8");
    expect(jsonl.headers.get("content-disposition")).toBe(`attachment; filename="${split}"`);
    expect(jsonl.headers.get("cache-control")).toBe("no-store");
    const text = await jsonl.text();
    expect(Number(jsonl.headers.get("content-length"))).toBe(Buffer.byteLength(text));
    const lines = text.trim().split("\n").map((line) => JSON.parse(line) as { messages: { role: string; content: string }[] });
    expect(lines).toHaveLength(1);
    expect(lines[0].messages[1]).toEqual({ role: "user", content: "Say hi to [REDACTED_EMAIL]" });

    const manifest = await getFile(get("/x"), fileParams(view.id, "manifest.json"));
    expect(manifest.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(((await manifest.json()) as { id: string }).id).toBe(view.id);
    const readme = await getFile(get("/x"), fileParams(view.id, "README.md"));
    expect(readme.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(await readme.text()).toContain("load_dataset");
  });

  it("refuses names outside the export's file list and unknown exports", async () => {
    seed();
    const view = await exportOnce();
    for (const name of ["../db", "../tatvam.db", "..%2Ftatvam.db", "..\\..\\tatvam.db", "tatvam.db", "dpo.jsonl", ".", ""]) {
      const response = await getFile(get("/x"), fileParams(view.id, name));
      expect(response.status, name).toBe(404);
    }
    expect((await getFile(get("/x"), fileParams(crypto.randomUUID(), "manifest.json"))).status).toBe(404);
    expect((await getFile(get("/x"), fileParams("../..", "manifest.json"))).status).toBe(404);
  });

  it("answers 404 when a recorded file is missing on disk", async () => {
    seed();
    const view = await exportOnce();
    rmSync(path.join(dir, "training", "exports", view.id, "README.md"));
    expect((await getFile(get("/x"), fileParams(view.id, "README.md"))).status).toBe(404);
  });
});
