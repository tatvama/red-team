import { describe, expect, it } from "vitest";
import type {
  AgentEvent,
  AssistantMessageView,
  ConversationDetail,
  ModelConnection,
  ToolCallView,
  UserMessageView,
} from "@/lib/contract";
import { checkpointView, conversationDetail, gitChanges, subagentView, workspaceInfo } from "@/test/fixtures";
import { type AgentAction, type AgentState, agentReducer, createInitialState, parseAgentEvent, resolveModel } from "./agent-state";

const CONVERSATION_ID = "11111111-1111-4111-8111-111111111111";
const NOW = "2026-10-10T12:00:00.000Z";

function run(state: AgentState, ...actions: AgentAction[]): AgentState {
  return actions.reduce(agentReducer, state);
}

const event = (value: AgentEvent): AgentAction => ({ type: "event", event: value });

const userMessage = (id: string, content = "Fix the tests"): UserMessageView => ({
  id,
  role: "user",
  content,
  createdAt: NOW,
});

const assistantMessage = (id: string, overrides: Partial<AssistantMessageView> = {}): AssistantMessageView => ({
  id,
  role: "assistant",
  content: "",
  reasoning: "",
  toolCalls: [],
  model: "qwen3",
  interrupted: false,
  createdAt: NOW,
  ...overrides,
});

const toolCall = (overrides: Partial<ToolCallView> = {}): ToolCallView => ({
  id: "call-1",
  name: "edit_file",
  title: "Edit file",
  arguments: '{"path":"a.ts","old_string":"a","new_string":"b"}',
  summary: "Edit a.ts",
  risk: "write",
  status: "running",
  ...overrides,
});

/** A new chat right after the user pressed send. */
function sentState(): AgentState {
  return run(createInitialState(null), { type: "send", runId: 1, message: userMessage("local-1") });
}

describe("agentReducer", () => {
  it("starts loading when opened on an existing conversation", () => {
    expect(createInitialState(CONVERSATION_ID).phase).toBe("loading");
    expect(createInitialState(null).phase).toBe("idle");
  });

  it("shows the optimistic user message and starts streaming on send", () => {
    const state = sentState();
    expect(state.phase).toBe("streaming");
    expect(state.messages).toEqual([userMessage("local-1")]);
    expect(state.pendingUserMessageId).toBe("local-1");
  });

  it("records a new conversation and lists it first", () => {
    const state = run(
      sentState(),
      event({ type: "conversation", conversation: { id: CONVERSATION_ID, title: "Fix tests", createdAt: NOW, updatedAt: NOW } }),
    );
    expect(state.conversationId).toBe(CONVERSATION_ID);
    expect(state.title).toBe("Fix tests");
    expect(state.conversations.map((c) => c.id)).toEqual([CONVERSATION_ID]);
  });

  it("replaces the optimistic user message with the server echo", () => {
    const state = run(sentState(), event({ type: "message", message: userMessage("server-1") }));
    expect(state.messages).toEqual([userMessage("server-1")]);
    expect(state.pendingUserMessageId).toBeNull();
  });

  it("appends a new assistant message and upserts by id", () => {
    const first = run(sentState(), event({ type: "message", message: assistantMessage("a1") }));
    expect(first.messages.map((m) => m.id)).toEqual(["local-1", "a1"]);
    const again = run(first, event({ type: "message", message: assistantMessage("a1", { content: "Done" }) }));
    expect(again.messages).toHaveLength(2);
    expect(again.messages[1]).toMatchObject({ id: "a1", content: "Done" });
  });

  it("appends reasoning and tokens to the right message", () => {
    const state = run(
      sentState(),
      event({ type: "message", message: assistantMessage("a1") }),
      event({ type: "reasoning", messageId: "a1", text: "Let me " }),
      event({ type: "reasoning", messageId: "a1", text: "think." }),
      event({ type: "token", messageId: "a1", text: "Hello" }),
      event({ type: "token", messageId: "a1", text: " world" }),
      event({ type: "token", messageId: "missing", text: "ignored" }),
    );
    expect(state.messages[1]).toMatchObject({ reasoning: "Let me think.", content: "Hello world" });
  });

  it("upserts tool calls and applies tool results", () => {
    const withCall = run(
      sentState(),
      event({ type: "message", message: assistantMessage("a1") }),
      event({ type: "tool_call", messageId: "a1", call: toolCall({ status: "awaiting_approval" }) }),
    );
    const callsOf = (state: AgentState) => (state.messages[1] as AssistantMessageView).toolCalls;
    expect(callsOf(withCall)).toEqual([toolCall({ status: "awaiting_approval" })]);

    const running = run(withCall, event({ type: "tool_call", messageId: "a1", call: toolCall({ status: "running" }) }));
    expect(callsOf(running)).toHaveLength(1);
    expect(callsOf(running)[0].status).toBe("running");

    const finished = run(
      running,
      event({ type: "tool_result", messageId: "a1", callId: "call-1", status: "ok", output: "Edited a.ts" }),
    );
    expect(callsOf(finished)[0]).toMatchObject({ status: "ok", output: "Edited a.ts" });
  });

  it("replaces the plan", () => {
    const first = run(sentState(), event({ type: "plan", plan: [{ step: "Read", status: "in_progress" }] }));
    const second = run(
      first,
      event({
        type: "plan",
        plan: [
          { step: "Read", status: "completed" },
          { step: "Edit", status: "pending" },
        ],
      }),
    );
    expect(second.plan).toEqual([
      { step: "Read", status: "completed" },
      { step: "Edit", status: "pending" },
    ]);
  });

  it("stops running on done and flags the step limit", () => {
    expect(run(sentState(), event({ type: "done", reason: "complete" }))).toMatchObject({
      phase: "idle",
      stepLimitReached: false,
    });
    expect(run(sentState(), event({ type: "done", reason: "awaiting_approval" })).phase).toBe("idle");
    expect(run(sentState(), event({ type: "done", reason: "max_steps" })).stepLimitReached).toBe(true);
  });

  it("shows a retryable error once the conversation exists", () => {
    const withConversation = run(
      sentState(),
      event({ type: "conversation", conversation: { id: CONVERSATION_ID, title: "t", createdAt: NOW, updatedAt: NOW } }),
      event({ type: "error", message: "Model crashed" }),
    );
    expect(withConversation.phase).toBe("idle");
    expect(withConversation.error).toEqual({ message: "Model crashed", retryable: true });

    const withoutConversation = run(sentState(), event({ type: "error", message: "Nope" }));
    expect(withoutConversation.error?.retryable).toBe(false);
  });

  it("removes the optimistic message when the server rejects the send", () => {
    const state = run(sentState(), { type: "send_failure", runId: 1, message: "Model offline" });
    expect(state.messages).toEqual([]);
    expect(state.phase).toBe("idle");
    expect(state.error).toEqual({ message: "Model offline", retryable: false });
  });

  it("marks the last assistant message interrupted when stopped", () => {
    const state = run(
      sentState(),
      event({ type: "message", message: assistantMessage("a1", { content: "Partial" }) }),
      { type: "run_end", runId: 1, stopped: true },
    );
    expect(state.phase).toBe("idle");
    expect((state.messages[1] as AssistantMessageView).interrupted).toBe(true);
  });

  it("ignores the end of an older run", () => {
    const state = run(sentState(), { type: "run_start", runId: 2 }, { type: "run_end", runId: 1, stopped: false });
    expect(state.phase).toBe("streaming");
    expect(state.runId).toBe(2);
  });

  it("applies a canonical refetch only for the current conversation when idle", () => {
    const detail: ConversationDetail = conversationDetail({
      id: CONVERSATION_ID,
      title: "Canonical",
      messages: [userMessage("u1"), assistantMessage("a1", { content: "Saved" })],
    });
    const loading = run(createInitialState(null), { type: "load_start", conversationId: CONVERSATION_ID });
    expect(loading.phase).toBe("loading");
    const loaded = run(loading, { type: "conversation_loaded", conversation: detail });
    expect(loaded).toMatchObject({ phase: "idle", title: "Canonical" });
    expect(loaded.messages).toHaveLength(2);

    const streaming = run(loaded, { type: "run_start", runId: 5 });
    expect(run(streaming, { type: "conversation_loaded", conversation: { ...detail, title: "Stale" } })).toBe(streaming);
    expect(run(loaded, { type: "conversation_loaded", conversation: { ...detail, id: "other" } })).toBe(loaded);
  });

  it("takes workspace, checkpoints, sub-agents and the running flag from the loaded detail", () => {
    const workspace = workspaceInfo({ mode: "worktree", branch: "tatvam/fix", baseBranch: "main" });
    const checkpoints = [checkpointView()];
    const subagents = [subagentView()];
    const loaded = run(createInitialState(CONVERSATION_ID), {
      type: "conversation_loaded",
      conversation: conversationDetail({ id: CONVERSATION_ID, workspace, checkpoints, subagents, running: true }),
    });
    expect(loaded).toMatchObject({ workspace, checkpoints, subagents, running: true });

    // Starting a run here means nothing else is running it; a new task clears everything.
    expect(run(loaded, { type: "run_start", runId: 3 }).running).toBe(false);
    expect(run(loaded, { type: "new_task" })).toMatchObject({
      workspace: null,
      checkpoints: [],
      subagents: [],
      running: false,
      changes: null,
    });
  });

  it("upserts sub-agents by id from live events", () => {
    const first = run(
      sentState(),
      event({ type: "subagent", messageId: "a1", subagent: subagentView({ id: "s1", steps: 1 }) }),
      event({ type: "subagent", messageId: "a1", subagent: subagentView({ id: "s2", role: "tester" }) }),
    );
    expect(first.subagents.map((s) => s.id)).toEqual(["s1", "s2"]);
    const updated = run(
      first,
      event({ type: "subagent", messageId: "a1", subagent: subagentView({ id: "s1", status: "done", steps: 4, report: "All good" }) }),
    );
    expect(updated.subagents).toHaveLength(2);
    expect(updated.subagents[0]).toMatchObject({ id: "s1", status: "done", steps: 4, report: "All good" });
  });

  it("merges live sub-agent events into the loaded ones", () => {
    const loaded = run(createInitialState(CONVERSATION_ID), {
      type: "conversation_loaded",
      conversation: conversationDetail({ id: CONVERSATION_ID, subagents: [subagentView({ id: "s1", status: "done" })] }),
    });
    const merged = run(
      loaded,
      { type: "run_start", runId: 1 },
      event({ type: "subagent", messageId: "a2", subagent: subagentView({ id: "s2" }) }),
    );
    expect(merged.subagents.map((s) => [s.id, s.status])).toEqual([
      ["s1", "done"],
      ["s2", "running"],
    ]);
  });

  it("appends checkpoints from live events", () => {
    const turn = checkpointView({ id: "c1" });
    const tool = checkpointView({ id: "c2", kind: "tool", messageId: null, toolCallId: "call-1", label: "Before: Edit a.ts" });
    const state = run(sentState(), event({ type: "checkpoint", checkpoint: turn }), event({ type: "checkpoint", checkpoint: tool }));
    expect(state.checkpoints).toEqual([turn, tool]);
    // A repeated checkpoint does not duplicate.
    expect(run(state, event({ type: "checkpoint", checkpoint: turn })).checkpoints).toHaveLength(2);
  });

  it("keeps changes only for the conversation they were fetched for", () => {
    const state = createInitialState(CONVERSATION_ID);
    const changes = gitChanges();
    const loaded = run(state, { type: "changes_loaded", conversationId: CONVERSATION_ID, changes });
    expect(loaded.changes).toBe(changes);
    expect(run(state, { type: "changes_loaded", conversationId: "other", changes })).toBe(state);

    const failed = run(loaded, { type: "changes_failure", conversationId: CONVERSATION_ID, message: "git failed" });
    expect(failed).toMatchObject({ changes, changesError: "git failed" });
    expect(run(failed, { type: "changes_loaded", conversationId: CONVERSATION_ID, changes }).changesError).toBeNull();
  });

  it("reports a load failure for the conversation being loaded", () => {
    const state = run(
      createInitialState(CONVERSATION_ID),
      { type: "load_failure", conversationId: CONVERSATION_ID, message: "Gone" },
    );
    expect(state).toMatchObject({ phase: "idle", loadError: "Gone" });
  });

  it("resets the conversation for a new task but keeps the list and connections", () => {
    const connection: ModelConnection = { provider: "ollama", state: "ready", models: ["qwen3"] };
    const state = run(
      sentState(),
      event({ type: "conversation", conversation: { id: CONVERSATION_ID, title: "t", createdAt: NOW, updatedAt: NOW } }),
      { type: "connection_loaded", connection },
      { type: "new_task" },
    );
    expect(state).toMatchObject({ conversationId: null, messages: [], phase: "idle" });
    expect(state.conversations).toHaveLength(1);
    expect(state.connections.ollama).toEqual(connection);
  });

  it("renames and deletes conversations in the list", () => {
    const summary = { id: CONVERSATION_ID, title: "Old", createdAt: NOW, updatedAt: NOW };
    const listed = run(createInitialState(CONVERSATION_ID), { type: "conversations_loaded", conversations: [summary] });
    const renamed = run(listed, { type: "conversation_renamed", conversation: { ...summary, title: "New" } });
    expect(renamed.conversations[0].title).toBe("New");
    expect(renamed.title).toBe("New");
    expect(run(renamed, { type: "conversation_deleted", conversationId: CONVERSATION_ID }).conversations).toEqual([]);
  });
});

describe("parseAgentEvent", () => {
  it("accepts well-formed events and rejects malformed ones", () => {
    expect(parseAgentEvent({ type: "token", messageId: "a1", text: "hi" })).toEqual({
      type: "token",
      messageId: "a1",
      text: "hi",
    });
    expect(parseAgentEvent({ type: "token", messageId: "a1" })).toBeNull();
    expect(parseAgentEvent({ type: "unknown" })).toBeNull();
    expect(parseAgentEvent("token")).toBeNull();
    expect(parseAgentEvent(null)).toBeNull();
  });

  it("accepts sub-agent and checkpoint events and rejects malformed ones", () => {
    const subagent = { type: "subagent", messageId: "a1", subagent: subagentView() };
    expect(parseAgentEvent(subagent)).toEqual(subagent);
    expect(parseAgentEvent({ type: "subagent", messageId: "a1", subagent: { id: "s1" } })).toBeNull();
    const checkpoint = { type: "checkpoint", checkpoint: checkpointView() };
    expect(parseAgentEvent(checkpoint)).toEqual(checkpoint);
    expect(parseAgentEvent({ type: "checkpoint", checkpoint: "c1" })).toBeNull();
  });
});

describe("resolveModel", () => {
  const ready = (provider: "ollama" | "gpu", models: string[]): ModelConnection => ({ provider, state: "ready", models });

  it("keeps the stored model while it is available", () => {
    const connections = { ollama: ready("ollama", ["a", "b"]), gpu: null };
    expect(resolveModel({ provider: "ollama", model: "b" }, connections)).toEqual({ provider: "ollama", model: "b" });
  });

  it("falls back to the first available model", () => {
    const connections = { ollama: { provider: "ollama", state: "offline", models: [] } as ModelConnection, gpu: ready("gpu", ["big"]) };
    expect(resolveModel({ provider: "ollama", model: "gone" }, connections)).toEqual({ provider: "gpu", model: "big" });
  });

  it("returns null when nothing is available", () => {
    expect(resolveModel({ provider: null, model: null }, { ollama: null, gpu: null })).toBeNull();
  });
});
