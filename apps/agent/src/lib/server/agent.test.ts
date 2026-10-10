// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { AgentEvent, PermissionMode } from "@/lib/contract";
import {
  conversationDetail,
  fitToBudget,
  runAgent,
  skipPendingCalls,
  toWire,
  wireTools,
  type AgentDeps,
} from "./agent";
import * as db from "./db";
import { ModelError, type CompletionFn, type CompletionRequest, type CompletionResult } from "./llm";
import type { ToolDefinition } from "./tools/types";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "tatvam-agent-"));
  vi.stubEnv("DATA_DIR", dir);
});
afterEach(() => {
  db.closeDb();
  rmSync(dir, { recursive: true, force: true });
});

const echoSchema = z.object({ text: z.string() }).strict();
function fakeTool(name: string, risk: ToolDefinition["risk"], defaultPolicy: ToolDefinition["defaultPolicy"]) {
  const run = vi.fn(async (input: { text: string }) => ({ status: "ok" as const, content: `${name}:${input.text}` }));
  const tool: ToolDefinition<typeof echoSchema> = {
    name,
    title: name,
    description: `${name} tool`,
    schema: echoSchema,
    defaultPolicy,
    risk,
    available: () => ({ ok: true }),
    summarize: (input) => `${name} ${input.text}`,
    run,
  };
  return { tool: tool as unknown as ToolDefinition, run };
}

type Step = Partial<CompletionResult> & { reasoning?: string; content?: string; error?: Error };
/** A scripted model: each call consumes the next step and streams its text. */
function scripted(steps: Step[]) {
  const requests: CompletionRequest[] = [];
  const complete: CompletionFn = async (request) => {
    requests.push(request);
    const step = steps.shift();
    if (!step) throw new Error("No scripted step left");
    if (step.reasoning) request.onDelta({ kind: "reasoning", text: step.reasoning });
    if (step.content) request.onDelta({ kind: "content", text: step.content });
    if (step.error) throw step.error;
    return {
      content: step.content ?? "",
      reasoning: step.reasoning ?? "",
      toolCalls: step.toolCalls ?? [],
      finishReason: step.finishReason ?? (step.toolCalls?.length ? "tool_calls" : "stop"),
    };
  };
  return { complete, requests };
}

const call = (id: string, name: string, args: object | string) => ({
  id,
  type: "function" as const,
  function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) },
});

async function run(deps: AgentDeps, options: { mode?: PermissionMode; content?: string; id?: string; signal?: AbortSignal } = {}) {
  const conversation =
    (options.id && db.getConversation(options.id)) ||
    db.createConversation({ title: "Test", provider: "ollama", model: "m", permissionMode: options.mode ?? "ask" });
  if (options.content) db.appendMessage(conversation.id, { role: "user", content: options.content });
  const events: AgentEvent[] = [];
  await runAgent({
    conversationId: conversation.id,
    provider: "ollama",
    model: "m",
    permissionMode: options.mode ?? "ask",
    signal: options.signal ?? new AbortController().signal,
    emit: (event) => events.push(event),
    deps,
  });
  return { id: conversation.id, events };
}

describe("runAgent", () => {
  it("streams a plain answer and stores it", async () => {
    const model = scripted([{ reasoning: "hmm", content: "Hello!" }]);
    const { id, events } = await run({ complete: model.complete, tools: [] }, { content: "hi" });
    expect(events.map((event) => event.type)).toEqual(["message", "reasoning", "token", "done"]);
    expect(events.at(-1)).toEqual({ type: "done", reason: "complete" });
    const messages = conversationDetail(id, [])!.messages;
    expect(messages.at(-1)).toMatchObject({ role: "assistant", content: "Hello!", reasoning: "hmm" });
    // The system prompt says no tools are available.
    expect(model.requests[0].messages[0].content).toMatch(/No tools are available/);
  });

  it("runs auto tools and feeds the result back to the model", async () => {
    const reader = fakeTool("peek", "read", "auto");
    const model = scripted([{ toolCalls: [call("c1", "peek", { text: "a" })] }, { content: "Saw it." }]);
    const { id, events } = await run({ complete: model.complete, tools: [reader.tool] }, { content: "look" });
    expect(reader.run).toHaveBeenCalledOnce();
    expect(events).toContainEqual(expect.objectContaining({ type: "tool_result", callId: "c1", status: "ok", output: "peek:a" }));
    expect(model.requests[1].messages.at(-1)).toEqual({ role: "tool", tool_call_id: "c1", content: "peek:a" });
    const view = conversationDetail(id, [reader.tool])!.messages[1];
    expect(view).toMatchObject({ role: "assistant", toolCalls: [{ id: "c1", status: "ok", summary: "peek a" }] });
  });

  it("pauses for approval, then runs the call after the user approves", async () => {
    const writer = fakeTool("put", "write", "ask");
    const deps = { complete: scripted([{ toolCalls: [call("c1", "put", { text: "x" })] }, { content: "Written." }]).complete, tools: [writer.tool] };
    const first = await run(deps, { content: "write it" });
    expect(first.events.at(-1)).toEqual({ type: "done", reason: "awaiting_approval" });
    expect(first.events).toContainEqual(expect.objectContaining({ type: "tool_call", call: expect.objectContaining({ status: "awaiting_approval" }) }));
    expect(writer.run).not.toHaveBeenCalled();
    expect(conversationDetail(first.id, [writer.tool])!.messages[1]).toMatchObject({ toolCalls: [{ status: "awaiting_approval" }] });

    db.recordApproval(first.id, "c1", "approve");
    const second = await run(deps, { id: first.id });
    expect(writer.run).toHaveBeenCalledOnce();
    expect(second.events.at(-1)).toEqual({ type: "done", reason: "complete" });
  });

  it("records a denial without running the tool", async () => {
    const writer = fakeTool("put", "write", "ask");
    const model = scripted([{ toolCalls: [call("c1", "put", { text: "x" })] }, { content: "Okay, I will not." }]);
    const deps = { complete: model.complete, tools: [writer.tool] };
    const first = await run(deps, { content: "write it" });
    db.recordApproval(first.id, "c1", "deny");
    const second = await run(deps, { id: first.id });
    expect(writer.run).not.toHaveBeenCalled();
    expect(second.events).toContainEqual(expect.objectContaining({ type: "tool_result", status: "denied" }));
    expect(model.requests[1].messages.at(-1)).toMatchObject({ role: "tool", content: expect.stringMatching(/denied/) });
  });

  it("auto-approves edits in accept-edits mode but still asks for commands", async () => {
    const writer = fakeTool("put", "write", "ask");
    const shell = fakeTool("sh", "execute", "ask");
    const model = scripted([{ toolCalls: [call("c1", "put", { text: "x" }), call("c2", "sh", { text: "ls" })] }]);
    const { events } = await run({ complete: model.complete, tools: [writer.tool, shell.tool] }, { content: "go", mode: "accept_edits" });
    expect(writer.run).toHaveBeenCalledOnce();
    expect(shell.run).not.toHaveBeenCalled();
    expect(events.at(-1)).toEqual({ type: "done", reason: "awaiting_approval" });
  });

  it("hides write and execute tools in plan mode and refuses them if called anyway", async () => {
    const reader = fakeTool("peek", "read", "auto");
    const writer = fakeTool("put", "write", "auto");
    const model = scripted([{ toolCalls: [call("c1", "put", { text: "x" })] }, { content: "Planned." }]);
    const { events } = await run({ complete: model.complete, tools: [reader.tool, writer.tool] }, { content: "plan", mode: "plan" });
    expect(model.requests[0].tools.map((tool) => tool.function.name)).toEqual(["peek"]);
    expect(writer.run).not.toHaveBeenCalled();
    expect(events).toContainEqual(expect.objectContaining({ type: "tool_result", status: "error", output: expect.stringMatching(/turned off/) }));
  });

  it("returns useful errors for unknown tools and invalid arguments", async () => {
    const reader = fakeTool("peek", "read", "auto");
    const model = scripted([
      { toolCalls: [call("c1", "rm_rf", {}), call("c2", "peek", "{not json"), call("c3", "peek", { text: 1, extra: true })] },
      { content: "Sorry." },
    ]);
    const { events } = await run({ complete: model.complete, tools: [reader.tool] }, { content: "go" });
    const outputs = events.flatMap((event) => (event.type === "tool_result" ? [event.output] : []));
    expect(outputs[0]).toMatch(/Unknown tool/);
    expect(outputs[1]).toMatch(/not valid JSON/);
    expect(outputs[2]).toMatch(/Invalid arguments/);
    expect(reader.run).not.toHaveBeenCalled();
  });

  it("falls back to a tool-free answer when the model cannot use tools", async () => {
    const reader = fakeTool("peek", "read", "auto");
    const model = scripted([{ error: new ModelError("no tools", "tools_unsupported") }, { content: "Plain answer." }]);
    const { id, events } = await run({ complete: model.complete, tools: [reader.tool] }, { content: "hi" });
    expect(model.requests[1].tools).toEqual([]);
    expect(events.at(-1)).toEqual({ type: "done", reason: "complete" });
    expect(conversationDetail(id, [])!.messages.at(-1)).toMatchObject({ content: expect.stringMatching(/does not support tools.*Plain answer/s) });
  });

  it("saves partial output when stopped mid-reply", async () => {
    const controller = new AbortController();
    const complete: CompletionFn = async (request) => {
      request.onDelta({ kind: "content", text: "Partial" });
      controller.abort();
      throw new ModelError("Stopped.", "interrupted");
    };
    const { id, events } = await run({ complete, tools: [] }, { content: "hi", signal: controller.signal });
    expect(events.at(-1)).toEqual({ type: "done", reason: "stopped" });
    expect(conversationDetail(id, [])!.messages.at(-1)).toMatchObject({ content: "Partial", interrupted: true });
  });

  it("reports model errors and drops the empty reply", async () => {
    const model = scripted([{ error: new ModelError("Could not reach the model server.", "unreachable") }]);
    const { id, events } = await run({ complete: model.complete, tools: [] }, { content: "hi" });
    expect(events.at(-1)).toEqual({ type: "error", message: "Could not reach the model server." });
    expect(conversationDetail(id, [])!.messages).toHaveLength(1);
  });

  it("stops at the step limit", async () => {
    vi.stubEnv("AGENT_MAX_STEPS", "2");
    const reader = fakeTool("peek", "read", "auto");
    const loop = Array.from({ length: 3 }, (_, index) => ({ toolCalls: [call(`c${index}`, "peek", { text: "a" })] }));
    const { events } = await run({ complete: scripted(loop).complete, tools: [reader.tool] }, { content: "go" });
    expect(reader.run).toHaveBeenCalledTimes(2);
    expect(events.at(-1)).toEqual({ type: "done", reason: "max_steps" });
  });

  it("closes abandoned approval requests when the user sends a new message", async () => {
    const writer = fakeTool("put", "write", "ask");
    const first = await run({ complete: scripted([{ toolCalls: [call("c1", "put", { text: "x" })] }]).complete, tools: [writer.tool] }, { content: "a" });
    skipPendingCalls(first.id);
    const wire = toWire(db.listMessages(first.id));
    expect(wire.at(-1)).toMatchObject({ role: "tool", tool_call_id: "c1", content: expect.stringMatching(/not run/) });
  });

  it("emits plan updates", async () => {
    const { updatePlanTool } = await import("./tools/plan");
    const plan = [{ step: "Look around", status: "in_progress" }];
    const model = scripted([{ toolCalls: [call("p1", "update_plan", { plan })] }, { content: "Planned." }]);
    const { id, events } = await run({ complete: model.complete, tools: [updatePlanTool as unknown as ToolDefinition] }, { content: "go" });
    expect(events).toContainEqual({ type: "plan", plan });
    expect(conversationDetail(id, [])!.plan).toEqual(plan);
  });
});

describe("wireTools", () => {
  it("sends strict JSON schemas without the $schema marker and keeps defaulted fields optional", () => {
    const schema = z.object({ path: z.string(), limit: z.number().default(10) }).strict();
    const tool = { ...fakeTool("peek", "read", "auto").tool, schema } as unknown as ToolDefinition;
    const [wire] = wireTools([tool]);
    expect(wire.function.parameters).not.toHaveProperty("$schema");
    expect(wire.function.parameters).toMatchObject({ type: "object", additionalProperties: false, required: ["path"] });
  });
});

describe("history shaping", () => {
  it("adds placeholder results for tool calls that never finished", () => {
    const conversation = db.createConversation({ title: "t", provider: "ollama", model: "m", permissionMode: "ask" });
    db.appendMessage(conversation.id, { role: "user", content: "go" });
    db.appendMessage(conversation.id, {
      role: "assistant",
      content: "",
      reasoning: "",
      toolCalls: [{ id: "c1", name: "peek", arguments: "{}" }],
      model: "m",
      interrupted: false,
    });
    expect(toWire(db.listMessages(conversation.id)).at(-1)).toEqual({ role: "tool", tool_call_id: "c1", content: "No result (interrupted)." });
  });

  it("elides old tool output first, then drops the oldest turns, keeping the latest turn", () => {
    const big = "x".repeat(5000);
    const history = [
      { role: "user" as const, content: "first" },
      { role: "assistant" as const, content: "", tool_calls: [call("c1", "peek", {})] },
      { role: "tool" as const, tool_call_id: "c1", content: big },
      { role: "assistant" as const, content: "done" },
      { role: "user" as const, content: "second" },
      { role: "assistant" as const, content: "ok" },
      { role: "user" as const, content: "third" },
    ];
    const elided = fitToBudget(history, 1000);
    expect(elided.trimmed).toBe(false);
    expect(elided.messages[2]).toMatchObject({ content: expect.stringMatching(/omitted/) });

    const dropped = fitToBudget(history, 150);
    expect(dropped.trimmed).toBe(true);
    expect(dropped.messages.at(-1)).toEqual({ role: "user", content: "third" });
    expect(dropped.messages[0].role).toBe("user");
  });
});
