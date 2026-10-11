// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { PUT as putFeedback } from "@/app/api/conversations/[id]/feedback/route";
import { PUT as putTraining } from "@/app/api/conversations/[id]/training/route";
import type { AgentEvent } from "@/lib/contract";
import { conversationDetail, runAgent } from "./agent";
import * as db from "./db";
import { ModelError, type CompletionFn } from "./llm";
import { saveRouterConfig } from "./router";
import type { ToolDefinition } from "./tools/types";

// The engine side of the training loop: feedback, training status, hidden job conversations,
// the router's fallback model and checkpoint skipping for evaluation runs.

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "tatvam-train-core-"));
  vi.stubEnv("DATA_DIR", dir);
});
afterEach(() => {
  db.closeDb();
  rmSync(dir, { recursive: true, force: true });
});

function seed(kind: "chat" | "eval" = "chat") {
  const conversation = db.createConversation({ title: "t", provider: "ollama", model: "m", permissionMode: "ask", kind });
  db.appendMessage(conversation.id, { role: "user", content: "hi" });
  const reply = db.appendMessage(conversation.id, {
    role: "assistant",
    content: "Hello",
    reasoning: "",
    toolCalls: [{ id: "call_1", name: "read_file", arguments: "{}" }],
    model: "m",
    interrupted: false,
  });
  return { id: conversation.id, replyId: reply.id };
}

const put = (handler: typeof putFeedback, id: string, body: unknown) =>
  handler(
    new Request(`http://127.0.0.1:3000/api/conversations/${id}/x`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );

describe("feedback", () => {
  it("rates replies and tool calls, stores corrections and clears when emptied", async () => {
    const { id, replyId } = seed();
    const rate = await put(putFeedback, id, { messageId: replyId, toolCallId: null, rating: "down", correction: "Hi there!", note: null });
    expect(rate.status).toBe(200);
    await put(putFeedback, id, { messageId: replyId, toolCallId: "call_1", rating: "up", correction: null, note: "good call" });
    const detail = conversationDetail(id, [])!;
    expect(detail.feedback).toEqual([
      expect.objectContaining({ messageId: replyId, toolCallId: null, rating: "down", correction: "Hi there!" }),
      expect.objectContaining({ messageId: replyId, toolCallId: "call_1", rating: "up", note: "good call" }),
    ]);
    await put(putFeedback, id, { messageId: replyId, toolCallId: "call_1", rating: null, correction: null, note: "  " });
    expect(conversationDetail(id, [])!.feedback).toHaveLength(1);
  });

  it("refuses feedback on user messages, unknown tool calls, other conversations and bad bodies", async () => {
    const { id, replyId } = seed();
    const other = seed();
    const userMessage = db.listMessages(id)[0].id;
    const body = (overrides: object) => ({ messageId: replyId, toolCallId: null, rating: "up", correction: null, note: null, ...overrides });
    expect((await put(putFeedback, id, body({ messageId: userMessage }))).status).toBe(400);
    expect((await put(putFeedback, id, body({ toolCallId: "call_other" }))).status).toBe(400);
    expect((await put(putFeedback, other.id, body({}))).status).toBe(400);
    expect((await put(putFeedback, id, body({ rating: "meh" }))).status).toBe(400);
    expect((await put(putFeedback, crypto.randomUUID(), body({}))).status).toBe(404);
  });
});

describe("rewinds", () => {
  it("delete the feedback given on the removed replies and keep the rest", async () => {
    const { id, replyId } = seed();
    const second = db.appendMessage(id, { role: "assistant", content: "Later", reasoning: "", toolCalls: [], model: "m", interrupted: false });
    db.saveFeedback(id, { messageId: replyId, toolCallId: null, rating: "up", correction: null, note: null });
    db.saveFeedback(id, { messageId: second.id, toolCallId: null, rating: "down", correction: "Better", note: null });
    db.deleteMessagesFrom(id, db.listMessages(id).find((message) => message.id === second.id)!.seq);
    expect(db.listFeedback(id).map((item) => item.messageId)).toEqual([replyId]);
  });
});

describe("training status and job conversations", () => {
  it("approves or excludes conversations", async () => {
    const { id } = seed();
    expect((await put(putTraining, id, { trainingStatus: "approved" })).status).toBe(200);
    expect(conversationDetail(id, [])!.trainingStatus).toBe("approved");
    expect((await put(putTraining, id, { trainingStatus: "maybe" })).status).toBe(400);
    expect((await put(putTraining, crypto.randomUUID(), { trainingStatus: "approved" })).status).toBe(404);
  });

  it("keeps evaluation and distillation conversations out of the sidebar", () => {
    const chat = seed("chat");
    const evalRun = seed("eval");
    expect(db.listConversations().map((item) => item.id)).toEqual([chat.id]);
    expect(conversationDetail(evalRun.id, [])!.kind).toBe("eval");
  });
});

const writeSchema = z.object({ text: z.string() }).strict();
const writer = {
  name: "put",
  title: "put",
  description: "put",
  schema: writeSchema,
  defaultPolicy: "auto",
  risk: "write",
  available: () => ({ ok: true }),
  summarize: () => "put",
  run: async () => ({ status: "ok", content: "done" }),
} as unknown as ToolDefinition;

async function run(id: string, complete: CompletionFn, tools: ToolDefinition[] = []) {
  const events: AgentEvent[] = [];
  await runAgent({
    conversationId: id,
    provider: "gpu",
    model: "primary",
    permissionMode: "full_auto",
    signal: new AbortController().signal,
    emit: (event) => events.push(event),
    deps: { complete, tools },
  });
  return events;
}

function fresh(kind: "chat" | "eval") {
  const conversation = db.createConversation({ title: "t", provider: "gpu", model: "primary", permissionMode: "full_auto", kind });
  db.appendMessage(conversation.id, { role: "user", content: "go" });
  return conversation.id;
}

describe("router fallback", () => {
  const fallback = { provider: "ollama" as const, model: "backup" };

  it("answers with the fallback model when the primary is down, and records which model replied", async () => {
    saveRouterConfig({ enabled: true, main: { provider: "gpu", model: "primary" }, subagent: null, judge: null, fallback, canary: null });
    const id = fresh("chat");
    const models: string[] = [];
    const events = await run(id, async (request) => {
      models.push(request.model);
      if (request.model === "primary") throw new ModelError("Could not reach the model server.", "unreachable");
      request.onDelta({ kind: "content", text: "From backup." });
      return { content: "From backup.", reasoning: "", toolCalls: [], finishReason: "stop" };
    });
    expect(models).toEqual(["primary", "backup"]);
    expect(events.at(-1)).toEqual({ type: "done", reason: "complete" });
    const reply = conversationDetail(id, [])!.messages.at(-1)!;
    expect(reply).toMatchObject({ role: "assistant", model: "backup", content: expect.stringMatching(/fallback model `backup`.*From backup\./s) });
  });

  it("does not fall back for client errors or when no fallback is configured", async () => {
    saveRouterConfig({ enabled: true, main: { provider: "gpu", model: "primary" }, subagent: null, judge: null, fallback, canary: null });
    const notFound = await run(fresh("chat"), async () => {
      throw new ModelError('Model "primary" was not found on the server.', "rejected", 404);
    });
    expect(notFound.at(-1)).toMatchObject({ type: "error" });

    saveRouterConfig({ enabled: false, main: null, subagent: null, judge: null, fallback: null, canary: null });
    const down = await run(fresh("chat"), async () => {
      throw new ModelError("Could not reach the model server.", "unreachable");
    });
    expect(down.at(-1)).toEqual({ type: "error", message: "Could not reach the model server." });
  });
});

describe("checkpoints by conversation kind", () => {
  it("checkpoints edits in chats but not in evaluation runs", async () => {
    const workspace = path.join(dir, "workspace");
    mkdirSync(workspace, { recursive: true });
    vi.stubEnv("WORKSPACE_DIR", workspace);
    const script = (): CompletionFn => {
      let call = 0;
      return async () =>
        ++call === 1
          ? { content: "", reasoning: "", finishReason: "tool_calls", toolCalls: [{ id: `w${call}`, type: "function", function: { name: "put", arguments: '{"text":"x"}' } }] }
          : { content: "Done.", reasoning: "", toolCalls: [], finishReason: "stop" };
    };
    const chatId = fresh("chat");
    const chatEvents = await run(chatId, script(), [writer]);
    expect(chatEvents.some((event) => event.type === "checkpoint")).toBe(true);

    const evalId = fresh("eval");
    const evalEvents = await run(evalId, script(), [writer]);
    expect(evalEvents.some((event) => event.type === "checkpoint")).toBe(false);
    expect(conversationDetail(evalId, [])!.checkpoints).toEqual([]);
  });
});
