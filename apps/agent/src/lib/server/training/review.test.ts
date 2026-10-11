// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as db from "../db";
import { listReviewQueue, REVIEW_QUEUE_LIMIT } from "./review";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "tatvam-review-"));
  vi.stubEnv("DATA_DIR", dir);
});
afterEach(() => {
  db.closeDb();
  rmSync(dir, { recursive: true, force: true });
});

function conversation(input: Partial<Parameters<typeof db.createConversation>[0]> = {}) {
  return db.createConversation({ title: "t", provider: "ollama", model: "qwen3", permissionMode: "ask", ...input });
}
const touch = (id: string, updatedAt: string) =>
  db.database().prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(updatedAt, id);
const assistant = (id: string, content: string, toolCalls: db.StoredToolCall[] = []) =>
  db.appendMessage(id, { role: "assistant", content, reasoning: "", toolCalls, model: "qwen3", interrupted: false });

describe("review queue", () => {
  it("counts messages, tool calls, ratings and corrections in SQL", () => {
    const { id } = conversation({ title: "Fix the parser", model: "qwen3-coder", trainingStatus: "approved" });
    db.appendMessage(id, { role: "user", content: "fix it" });
    const withCalls = assistant(id, "", [
      { id: "call_1", name: "read_file", arguments: "{}" },
      { id: "call_2", name: "edit_file", arguments: "{}" },
    ]);
    db.appendMessage(id, { role: "tool", toolCallId: "call_1", content: "x", status: "ok" });
    db.appendMessage(id, { role: "tool", toolCallId: "call_2", content: "y", status: "ok" });
    const final = assistant(id, "Fixed.");
    assistant(id, ""); // an empty reply is not shown, so it is not counted
    db.appendMessage(id, { role: "user", content: "thanks" });
    const removed = assistant(id, "You're welcome", [{ id: "call_3", name: "calculator", arguments: "{}" }]);

    db.saveFeedback(id, { messageId: withCalls.id, toolCallId: "call_1", rating: "up", correction: null, note: null });
    db.saveFeedback(id, { messageId: withCalls.id, toolCallId: null, rating: "down", correction: "Read first.", note: null });
    db.saveFeedback(id, { messageId: final.id, toolCallId: null, rating: "up", correction: null, note: "good" });
    db.saveFeedback(id, { messageId: removed.id, toolCallId: null, rating: "down", correction: "No.", note: null });
    // Feedback on a deleted message no longer counts; its tool calls go with it.
    db.deleteMessage(removed.id);

    const [view] = listReviewQueue();
    expect(view).toEqual({
      id,
      title: "Fix the parser",
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
      kind: "chat",
      trainingStatus: "approved",
      model: "qwen3-coder",
      messageCount: 4,
      toolCallCount: 2,
      upCount: 2,
      downCount: 1,
      correctionCount: 1,
    });
  });

  it("returns zero counts for an empty conversation", () => {
    conversation({ kind: "distill" });
    expect(listReviewQueue()[0]).toMatchObject({ kind: "distill", trainingStatus: "unreviewed", messageCount: 0, toolCallCount: 0, upCount: 0 });
  });

  it("filters by status and kind and lists the newest first", () => {
    const old = conversation({ title: "old chat", trainingStatus: "approved" });
    const recent = conversation({ title: "recent chat", trainingStatus: "approved" });
    const evalRun = conversation({ title: "eval", kind: "eval" });
    const excluded = conversation({ title: "excluded", trainingStatus: "excluded" });
    touch(old.id, "2026-10-01T00:00:00.000Z");
    touch(recent.id, "2026-10-09T00:00:00.000Z");
    touch(evalRun.id, "2026-10-05T00:00:00.000Z");
    touch(excluded.id, "2026-10-07T00:00:00.000Z");

    const titles = (filters: Parameters<typeof listReviewQueue>[0]) => listReviewQueue(filters).map((view) => view.title);
    expect(titles({})).toEqual(["recent chat", "excluded", "eval", "old chat"]);
    expect(titles({ status: "approved" })).toEqual(["recent chat", "old chat"]);
    expect(titles({ kind: "eval" })).toEqual(["eval"]);
    expect(titles({ status: "unreviewed", kind: "eval" })).toEqual(["eval"]);
    expect(titles({ status: "excluded", kind: "chat" })).toEqual(["excluded"]);
    expect(titles({ kind: "distill" })).toEqual([]);
  });

  it("returns at most 500 conversations", () => {
    const insert = db.database().prepare(
      "INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
    );
    db.database().exec("BEGIN");
    for (let index = 0; index < REVIEW_QUEUE_LIMIT + 5; index++) {
      const time = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
      insert.run(crypto.randomUUID(), `c${index}`, time, time);
    }
    db.database().exec("COMMIT");
    const queue = listReviewQueue();
    expect(queue).toHaveLength(500);
    expect(queue[0].title).toBe(`c${REVIEW_QUEUE_LIMIT + 4}`);
  });
});
