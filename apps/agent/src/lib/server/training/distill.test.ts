// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DistillJobView, DistillRequest } from "@/lib/contract";
import * as db from "../db";
import { ModelError } from "../llm";
import { saveRouterConfig } from "../router";
import { cancelDistillJob, DistillRequestError, getDistillJob, historyPrompts, listDistillJobs, startDistillJob } from "./distill";
import { drainJobs, waitForJob } from "./jobs";
import { gate, scriptedModel } from "./test-helpers";

let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), "tatvam-distill-"));
  vi.stubEnv("DATA_DIR", dataDir);
});
afterEach(async () => {
  await drainJobs();
  db.closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

const teacher = { provider: "gpu" as const, model: "teacher" };
const prompts = (list: string[], autoApprove = false): DistillRequest => ({ teacher, source: { type: "prompts", prompts: list }, autoApprove });

async function finished(job: DistillJobView): Promise<DistillJobView> {
  await waitForJob(job.id);
  return getDistillJob(job.id)!;
}

function chat(prompt: string, updatedAt: string): string {
  const conversation = db.createConversation({ title: prompt, provider: "ollama", model: "student", permissionMode: "ask" });
  db.appendMessage(conversation.id, { role: "user", content: prompt });
  db.appendMessage(conversation.id, { role: "assistant", content: "Answer", reasoning: "", toolCalls: [], model: "student", interrupted: false });
  db.database().prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(updatedAt, conversation.id);
  return conversation.id;
}

describe("distillation", () => {
  it("answers each prompt with the teacher in plan mode, for review", async () => {
    const model = scriptedModel((prompt) => [{ content: `Teacher answer to: ${prompt}` }]);
    const started = startDistillJob(prompts(["Explain closures in JavaScript", "What is a mutex?"]), { complete: model.complete });
    expect(started).toMatchObject({ status: "running", total: 2, completed: 0, failed: 0, teacher });

    const job = await finished(started);
    expect(job).toMatchObject({ status: "completed", total: 2, completed: 2, failed: 0, error: null });
    expect(job.finishedAt).not.toBeNull();
    expect(job.conversationIds).toHaveLength(2);
    const conversations = job.conversationIds.map((id) => db.getConversation(id)!);
    expect(conversations.map((item) => [item.title, item.kind, item.trainingStatus, item.permissionMode, item.model])).toEqual([
      ["Explain closures in JavaScript", "distill", "unreviewed", "plan", "teacher"],
      ["What is a mutex?", "distill", "unreviewed", "plan", "teacher"],
    ]);
    expect(conversations[0].workspacePath).toBeNull();
    expect(db.listMessages(job.conversationIds[1]).map((message) => [message.role, message.content])).toEqual([
      ["user", "What is a mutex?"],
      ["assistant", "Teacher answer to: What is a mutex?"],
    ]);
    // Teacher requests run in plan mode: no edit or command tools are offered.
    expect(model.requests.every((request) => request.provider === "gpu" && request.model === "teacher")).toBe(true);
    const offered = model.requests[0].tools.map((tool) => tool.function.name);
    expect(offered).toContain("read_file");
    expect(offered).not.toContain("edit_file");
    expect(offered).not.toContain("write_file");
    // Distillation conversations stay out of the chat sidebar.
    expect(db.listConversations()).toEqual([]);

    const row = db.database().prepare("SELECT teacher FROM distill_jobs WHERE id = ?").get(job.id) as { teacher: string };
    expect(row.teacher).toBe('{"provider":"gpu","model":"teacher"}');
  });

  it("auto-approves finished answers but not failed ones", async () => {
    const model = scriptedModel((prompt) =>
      prompt.startsWith("Broken") ? [{ error: new ModelError("The model server returned HTTP 500.", "rejected", 500) }] : [{ content: "Good answer" }],
    );
    const job = await finished(startDistillJob(prompts(["Good question", "Broken question"], true), { complete: model.complete }));
    expect(job).toMatchObject({ status: "completed", completed: 1, failed: 1 });
    expect(job.conversationIds.map((id) => db.getConversation(id)!.trainingStatus)).toEqual(["approved", "unreviewed"]);
  });

  it("re-asks the first message of recent chats, newest first and deduplicated", async () => {
    chat("Oldest question", "2026-01-01T00:00:00.000Z");
    chat("Repeated question", "2026-01-02T00:00:00.000Z");
    chat("Repeated question", "2026-01-03T00:00:00.000Z");
    chat("Newest question", "2026-01-04T00:00:00.000Z");
    db.createConversation({ title: "Empty", provider: "ollama", model: "m", permissionMode: "ask" });
    expect(historyPrompts(10)).toEqual(["Newest question", "Repeated question", "Oldest question"]);
    expect(historyPrompts(2)).toEqual(["Newest question", "Repeated question"]);

    const model = scriptedModel(() => [{ content: "Teacher answer" }]);
    const job = await finished(startDistillJob({ teacher, source: { type: "history", limit: 2 }, autoApprove: true }, { complete: model.complete }));
    expect(job).toMatchObject({ total: 2, completed: 2 });
    expect(job.conversationIds.map((id) => db.getConversation(id)!.title)).toEqual(["Newest question", "Repeated question"]);
    expect(job.conversationIds.map((id) => db.getConversation(id)!.trainingStatus)).toEqual(["approved", "approved"]);
  });

  it("refuses history distillation when there is no history", () => {
    expect(() => startDistillJob({ teacher, source: { type: "history", limit: 5 }, autoApprove: false })).toThrow(DistillRequestError);
    expect(listDistillJobs()).toEqual([]);
  });

  it("counts a reply from the router's fallback model as failed", async () => {
    saveRouterConfig({ enabled: true, main: teacher, subagent: null, judge: null, fallback: { provider: "ollama", model: "small" }, canary: null });
    const model = scriptedModel((_, request) => (request.model === "teacher" ? [{ error: new ModelError("down", "unreachable") }] : [{ content: "ok" }]));
    const job = await finished(startDistillJob(prompts(["Question"], true), { complete: model.complete }));
    expect(job).toMatchObject({ completed: 0, failed: 1 });
    expect(db.getConversation(job.conversationIds[0])!.trainingStatus).toBe("unreviewed");
  });

  it("cancels a running job and a queued one", async () => {
    const hold = gate();
    const model = scriptedModel(() => [{ wait: hold.promise, content: "late" }]);
    const first = startDistillJob(prompts(["First", "Second"], true), { complete: model.complete });
    const second = startDistillJob(prompts(["Third"]), { complete: model.complete });
    expect(second.status).toBe("queued");
    await vi.waitFor(() => expect(model.requests.length).toBe(1));
    // With autoApprove, a conversation is approved only after the teacher finishes.
    expect(db.getConversation(getDistillJob(first.id)!.conversationIds[0])!.trainingStatus).toBe("unreviewed");

    expect(cancelDistillJob(second.id)?.status).toBe("cancelled");
    expect(cancelDistillJob(first.id)?.status).toBe("cancelled");
    const job = await finished(first);
    expect(job).toMatchObject({ status: "cancelled", completed: 0, failed: 0, total: 2 });
    expect(job.finishedAt).not.toBeNull();
    expect(job.conversationIds).toHaveLength(1);
    // The interrupted conversation is not left approved for training.
    expect(db.getConversation(job.conversationIds[0])!.trainingStatus).toBe("unreviewed");
    expect(getDistillJob(second.id)).toMatchObject({ status: "cancelled", conversationIds: [] });
    expect(cancelDistillJob(crypto.randomUUID())).toBeNull();
    expect(listDistillJobs().map((item) => item.id)).toEqual([second.id, first.id]);
  });
});
