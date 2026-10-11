// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { AgentEvent, SubagentView } from "@/lib/contract";
import * as db from "./db";
import { ModelError, type CompletionFn, type CompletionRequest } from "./llm";
import { delegateTool } from "./subagents";
import type { AgentRuntime, ToolDefinition } from "./tools/types";

let dir: string;
let conversationId: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "tatvam-sub-"));
  vi.stubEnv("DATA_DIR", dir);
  conversationId = db.createConversation({ title: "t", provider: "ollama", model: "m", permissionMode: "ask" }).id;
});
afterEach(() => {
  db.closeDb();
  rmSync(dir, { recursive: true, force: true });
});

const anyInput = z.object({ text: z.string().optional() }).strict();
function tool(name: string, risk: ToolDefinition["risk"]): ToolDefinition {
  return {
    name,
    title: name,
    description: name,
    schema: anyInput,
    defaultPolicy: risk === "read" ? "auto" : "ask",
    risk,
    available: () => ({ ok: true }),
    summarize: () => `Using ${name}`,
    run: async () => ({ status: "ok", content: `${name} output` }),
  } as unknown as ToolDefinition;
}
const tools = [tool("list_files", "read"), tool("read_file", "read"), tool("run_command", "execute"), tool("web_search", "network")];

function runtime(complete: CompletionFn, policy: (tool: ToolDefinition) => "auto" | "ask" | "off" = (t) => t.defaultPolicy) {
  const events: AgentEvent[] = [];
  const executed: string[] = [];
  const value: AgentRuntime = {
    provider: "ollama",
    model: "m",
    permissionMode: "ask",
    messageId: "msg-1",
    callId: "call-1",
    emit: (event) => events.push(event),
    complete,
    tools,
    execute: async (t, input) => {
      executed.push(t.name);
      return t.run(input as never, { signal: new AbortController().signal, conversationId });
    },
    policyOf: policy,
  };
  return { value, events, executed };
}

const reply = (content: string, toolCalls: { id: string; name: string; args?: object }[] = []) => ({
  content,
  reasoning: "",
  finishReason: toolCalls.length ? "tool_calls" : "stop",
  toolCalls: toolCalls.map((call) => ({
    id: call.id,
    type: "function" as const,
    function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
  })),
});

const run = (input: unknown, rt?: AgentRuntime, signal = new AbortController().signal) =>
  delegateTool.run(delegateTool.schema.parse(input), { signal, conversationId, runtime: rt });

const finalViews = (events: AgentEvent[]) => {
  const latest = new Map<string, SubagentView>();
  for (const event of events) if (event.type === "subagent") latest.set(event.subagent.id, event.subagent);
  return [...latest.values()];
};

describe("delegate_tasks", () => {
  it("runs sub-agents in parallel up to the limit and returns their reports", async () => {
    vi.stubEnv("SUBAGENT_MAX_PARALLEL", "2");
    let active = 0;
    let peak = 0;
    const complete: CompletionFn = async (request) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active--;
      return reply(`Report for: ${String(request.messages[1].content).slice(0, 6)}`);
    };
    const rt = runtime(complete);
    const result = await run(
      { tasks: ["task-a", "task-b", "task-c"].map((task) => ({ role: "general", task })) },
      rt.value,
    );
    expect(peak).toBe(2);
    expect(result.status).toBe("ok");
    expect(result.content).toMatch(/Sub-agent reports \(3\)/);
    expect(result.content).toMatch(/Report for: task-a[\s\S]*Report for: task-b[\s\S]*Report for: task-c/);
    expect(finalViews(rt.events).map((view) => view.status)).toEqual(["done", "done", "done"]);
    expect(db.listSubagentRuns(conversationId)).toHaveLength(3);
  });

  it("gives each role only its tools, and only those that run without approval", async () => {
    const seen: CompletionRequest[] = [];
    const complete: CompletionFn = async (request) => {
      seen.push(request);
      return reply("done");
    };
    await run({ tasks: [{ role: "tester", task: "run tests" }, { role: "reviewer", task: "review" }] }, runtime(complete).value);
    const names = (request: CompletionRequest) => request.tools.map((item) => item.function.name).sort();
    const tester = seen.find((request) => String(request.messages[1].content) === "run tests")!;
    const reviewer = seen.find((request) => String(request.messages[1].content) === "review")!;
    // run_command needs approval in ask mode, so the tester cannot run it and is told so.
    expect(names(tester)).toEqual(["list_files", "read_file"]);
    expect(tester.messages[0].content).toMatch(/Not available under the current permission mode: run_command/);
    expect(names(reviewer)).toEqual(["list_files", "read_file"]);
  });

  it("lets the tester run commands when the mode auto-approves them, and refuses tools outside its role", async () => {
    let call = 0;
    const complete: CompletionFn = async () =>
      ++call === 1
        ? reply("", [
            { id: "a", name: "run_command", args: { text: "npm test" } },
            { id: "b", name: "web_search", args: { text: "x" } },
          ])
        : reply("All 12 tests passed.");
    const rt = runtime(complete, () => "auto");
    const result = await run({ tasks: [{ role: "tester", task: "run tests" }] }, rt.value);
    expect(rt.executed).toEqual(["run_command"]);
    expect(result.content).toMatch(/All 12 tests passed/);
  });

  it("asks for a final report when a sub-agent runs out of steps", async () => {
    vi.stubEnv("SUBAGENT_MAX_STEPS", "2");
    const requests: CompletionRequest[] = [];
    const complete: CompletionFn = async (request) => {
      requests.push(request);
      return request.tools.length ? reply("", [{ id: `c${requests.length}`, name: "list_files" }]) : reply("Summary after limit.");
    };
    const rt = runtime(complete);
    const result = await run({ tasks: [{ role: "general", task: "explore" }] }, rt.value);
    expect(requests).toHaveLength(3);
    expect(requests[2].tools).toEqual([]);
    expect(result.content).toMatch(/Summary after limit/);
  });

  it("reports model failures and stops cleanly when aborted", async () => {
    const failing = runtime(async () => {
      throw new ModelError("Could not reach the model server.", "unreachable");
    });
    const failed = await run({ tasks: [{ role: "general", task: "x" }] }, failing.value);
    expect(failed.status).toBe("error");
    expect(finalViews(failing.events)[0]).toMatchObject({ status: "error", report: "Could not reach the model server." });

    const controller = new AbortController();
    const stopping = runtime(async () => {
      controller.abort();
      throw new ModelError("Stopped.", "interrupted");
    });
    await run({ tasks: [{ role: "general", task: "x" }] }, stopping.value, controller.signal);
    expect(finalViews(stopping.events)[0].status).toBe("stopped");
  });

  it("refuses to run without a parent agent (no nested delegation)", async () => {
    const result = await run({ tasks: [{ role: "general", task: "x" }] });
    expect(result).toEqual({ status: "error", content: "Sub-agents cannot start other sub-agents." });
  });

  it("validates its input", () => {
    expect(delegateTool.schema.safeParse({ tasks: [] }).success).toBe(false);
    expect(delegateTool.schema.safeParse({ tasks: [{ role: "hacker", task: "x" }] }).success).toBe(false);
    expect(delegateTool.schema.safeParse({ tasks: Array.from({ length: 7 }, () => ({ role: "general", task: "x" })) }).success).toBe(
      false,
    );
  });
});
