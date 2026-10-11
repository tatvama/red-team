// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as approve } from "@/app/api/agent/approve/route";
import { POST as agent } from "@/app/api/agent/route";
import { DELETE as deleteConversation, GET as getConversation } from "@/app/api/conversations/[id]/route";
import { GET as listConversations } from "@/app/api/conversations/route";
import { GET as getSettings, PUT as putSettings } from "@/app/api/settings/route";
import type { AgentEvent, ConversationDetail, SettingsView } from "@/lib/contract";
import { closeDb } from "./db";

// End-to-end through the real route handlers, with the model server replaced by scripted SSE.

let dir: string;
let replies: string[];
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "tatvam-routes-"));
  vi.stubEnv("DATA_DIR", dir);
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
afterEach(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

const sse = (...deltas: object[]) =>
  deltas.map((delta) => `data: ${JSON.stringify({ choices: [{ index: 0, delta }] })}\n\n`).join("") + "data: [DONE]\n\n";

const base = "http://127.0.0.1:3000";
const json = (url: string, method: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(base + url, { method, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const params = (id: string) => ({ params: Promise.resolve({ id }) });

async function events(response: Response): Promise<AgentEvent[]> {
  expect(response.status).toBe(200);
  const text = await response.text();
  return text.trim().split("\n").map((line) => JSON.parse(line) as AgentEvent);
}

const run = { provider: "ollama", model: "qwen3", permissionMode: "ask" };

describe("agent routes", () => {
  it("creates a conversation, streams the reply and persists it", async () => {
    replies.push(sse({ reasoning_content: "Greeting." }, { content: "Hi " }, { content: "there!" }));
    const stream = await events(await agent(json("/api/agent", "POST", { ...run, content: "Hello\nmore" })));
    expect(stream.map((event) => event.type)).toEqual([
      "conversation",
      "message",
      "message",
      "reasoning",
      "token",
      "token",
      "done",
    ]);
    const conversation = stream[0].type === "conversation" ? stream[0].conversation : null;
    expect(conversation?.title).toBe("Hello");

    const list = (await (await listConversations(new Request(base + "/api/conversations"))).json()) as { conversations: { id: string }[] };
    expect(list.conversations.map((item) => item.id)).toEqual([conversation!.id]);
    const detail = (await (await getConversation(new Request(base), params(conversation!.id))).json()) as ConversationDetail;
    expect(detail.messages.map((message) => [message.role, message.content])).toEqual([
      ["user", "Hello\nmore"],
      ["assistant", "Hi there!"],
    ]);
  });

  it("waits for approval, rejects stale approvals, then continues after approval", async () => {
    const settings = (await (await getSettings(new Request(base))).json()) as SettingsView;
    const policies = Object.fromEntries(settings.tools.map((tool) => [tool.name, tool.policy]));
    await putSettings(json("/api/settings", "PUT", { instructions: "", toolPolicies: { ...policies, update_plan: "ask" } }));

    const plan = [{ step: "Do it", status: "in_progress" }];
    replies.push(
      sse({ tool_calls: [{ index: 0, id: "call_plan", function: { name: "update_plan", arguments: JSON.stringify({ plan }) } }] }),
      sse({ content: "Plan saved." }),
    );
    const first = await events(await agent(json("/api/agent", "POST", { ...run, content: "plan it" })));
    expect(first.at(-1)).toEqual({ type: "done", reason: "awaiting_approval" });
    const id = first[0].type === "conversation" ? first[0].conversation.id : "";

    const stale = await approve(json("/api/agent/approve", "POST", { ...run, conversationId: id, callId: "call_other", decision: "approve" }));
    expect(stale.status).toBe(409);

    const second = await events(
      await approve(json("/api/agent/approve", "POST", { ...run, conversationId: id, callId: "call_plan", decision: "approve" })),
    );
    expect(second).toContainEqual({ type: "plan", plan });
    expect(second.at(-1)).toEqual({ type: "done", reason: "complete" });
  });

  it("remembers 'always allow' for the rest of the conversation", async () => {
    const settings = (await (await getSettings(new Request(base))).json()) as SettingsView;
    const policies = Object.fromEntries(settings.tools.map((tool) => [tool.name, tool.policy]));
    await putSettings(json("/api/settings", "PUT", { instructions: "", toolPolicies: { ...policies, calculator: "ask" } }));
    const calc = (id: string) =>
      sse({ tool_calls: [{ index: 0, id, function: { name: "calculator", arguments: '{"expression":"2+2"}' } }] });
    replies.push(calc("c1"));
    const first = await events(await agent(json("/api/agent", "POST", { ...run, content: "add" })));
    const id = first[0].type === "conversation" ? first[0].conversation.id : "";

    replies.push(sse({ content: "4" }), calc("c2"), sse({ content: "Still 4" }));
    await events(await approve(json("/api/agent/approve", "POST", { ...run, conversationId: id, callId: "c1", decision: "approve_always" })));
    const next = await events(await agent(json("/api/agent", "POST", { ...run, conversationId: id, content: "again" })));
    expect(next.at(-1)).toEqual({ type: "done", reason: "complete" });
    const detail = (await (await getConversation(new Request(base), params(id))).json()) as ConversationDetail;
    expect(detail.allowedTools).toEqual(["calculator"]);
  });

  it("refuses cross-origin requests and invalid bodies", async () => {
    const crossOrigin = await agent(json("/api/agent", "POST", { ...run, content: "hi" }, { origin: "https://evil.example" }));
    expect(crossOrigin.status).toBe(403);
    const invalid = await agent(json("/api/agent", "POST", { ...run, content: "hi", baseUrl: "http://169.254.169.254" }));
    expect(invalid.status).toBe(400);
    const unknown = await agent(json("/api/agent", "POST", { ...run, conversationId: crypto.randomUUID() }));
    expect(unknown.status).toBe(404);
  });

  it("deletes conversations", async () => {
    replies.push(sse({ content: "ok" }));
    const stream = await events(await agent(json("/api/agent", "POST", { ...run, content: "hi" })));
    const id = stream[0].type === "conversation" ? stream[0].conversation.id : "";
    expect((await deleteConversation(new Request(base, { method: "DELETE" }), params(id))).status).toBe(204);
    expect((await getConversation(new Request(base), params(id))).status).toBe(404);
  });

  it("ignores unknown tool names when saving settings", async () => {
    const response = await putSettings(json("/api/settings", "PUT", { instructions: "Be brief.", toolPolicies: { not_a_tool: "auto" } }));
    const view = (await response.json()) as SettingsView;
    expect(view.instructions).toBe("Be brief.");
    expect(view.tools.some((tool) => tool.name === "not_a_tool")).toBe(false);
  });
});
