import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, ConversationDetail, DefaultWorkspaceView } from "@/lib/contract";
import { navigateTo } from "@/lib/client/navigation";
import { checkpointView, conversationDetail, gitChanges, workspaceInfo } from "@/test/fixtures";
import { AgentApp } from "./agent-app";

vi.mock("@/lib/client/navigation", () => ({ navigateTo: vi.fn() }));

const ID = "22222222-2222-4222-8222-222222222222";
const NOW = "2026-10-10T12:00:00.000Z";

const events: AgentEvent[] = [
  { type: "conversation", conversation: { id: ID, title: "Fix the parser", createdAt: NOW, updatedAt: NOW } },
  { type: "message", message: { id: "u1", role: "user", content: "Fix the parser", createdAt: NOW } },
  {
    type: "message",
    message: { id: "a1", role: "assistant", content: "", reasoning: "", toolCalls: [], model: "qwen3", interrupted: false, createdAt: NOW },
  },
  { type: "reasoning", messageId: "a1", text: "Looking at the parser." },
  { type: "token", messageId: "a1", text: "I need to edit " },
  { type: "token", messageId: "a1", text: "**parser.ts**." },
  {
    type: "tool_call",
    messageId: "a1",
    call: {
      id: "call-1",
      name: "edit_file",
      title: "Edit file",
      arguments: '{"path":"parser.ts","old_string":"a","new_string":"b"}',
      summary: "Edit parser.ts",
      risk: "write",
      status: "awaiting_approval",
    },
  },
  { type: "done", reason: "awaiting_approval" },
];

/** Canonical state the server saved, fetched after the stream ends. */
const detail: ConversationDetail = conversationDetail({
  id: ID,
  title: "Fix the parser",
  messages: [
    { id: "u1", role: "user", content: "Fix the parser", createdAt: NOW },
    {
      id: "a1",
      role: "assistant",
      content: "I need to edit **parser.ts**.",
      reasoning: "Looking at the parser.",
      toolCalls: events.flatMap((event) => (event.type === "tool_call" ? [event.call] : [])),
      model: "qwen3",
      interrupted: false,
      createdAt: NOW,
    },
  ],
});

/** NDJSON body split mid-line, the way a network stream may deliver it. */
function ndjson(items: AgentEvent[]): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(items.map((item) => JSON.stringify(item)).join("\n") + "\n");
  const middle = Math.floor(bytes.length / 2);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.slice(0, middle));
      controller.enqueue(bytes.slice(middle));
      controller.close();
    },
  });
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("AgentApp", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    window.localStorage.clear();
    window.history.replaceState(null, "", "/");
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.startsWith("/api/models?provider=ollama")) return json({ provider: "ollama", state: "ready", models: ["qwen3"] });
      if (url.startsWith("/api/models?provider=gpu")) return json({ provider: "gpu", state: "unconfigured", models: [] });
      if (url === "/api/conversations") return json({ conversations: [] });
      if (url === `/api/conversations/${ID}`) return json(detail);
      if (url === "/api/agent" && init?.method === "POST") {
        return new Response(ndjson(events), { headers: { "Content-Type": "application/x-ndjson" } });
      }
      return json({ error: "Not found" }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    fetchMock.mockReset();
  });

  it("streams a new task into the transcript and shows the approval card", async () => {
    render(<AgentApp initialConversationId={null} />);
    expect(screen.getByRole("heading", { name: "What should we build today?" })).toBeInTheDocument();

    const input = screen.getByRole("textbox", { name: "Message" });
    await waitFor(() => expect(screen.getByRole("button", { name: /Model: qwen3/ })).toBeInTheDocument());
    await userEvent.type(input, "Fix the parser{Enter}");

    expect(await screen.findByRole("heading", { name: "Edit parser.ts" })).toBeInTheDocument();
    expect(screen.getByText("parser.ts", { selector: "strong" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled();
    expect(window.location.pathname).toBe(`/c/${ID}`);
    expect(screen.getByRole("heading", { level: 1, name: "Fix the parser" })).toBeInTheDocument();

    const agentCall = fetchMock.mock.calls.find(([url]) => url === "/api/agent");
    expect(JSON.parse(String(agentCall?.[1]?.body))).toEqual({
      provider: "ollama",
      model: "qwen3",
      permissionMode: "ask",
      content: "Fix the parser",
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(`/api/conversations/${ID}`, expect.anything()));
  });

  it("restores the draft and shows the error when the server rejects a message", async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith("/api/models?provider=ollama")) return json({ provider: "ollama", state: "ready", models: ["qwen3"] });
      if (url.startsWith("/api/models")) return json({ provider: "gpu", state: "offline", models: [] });
      if (url === "/api/conversations") return json({ conversations: [] });
      return json({ error: "The model server is not reachable." }, 502);
    });
    render(<AgentApp initialConversationId={null} />);
    const input = screen.getByRole("textbox", { name: "Message" });
    await waitFor(() => expect(screen.getByRole("button", { name: /Model: qwen3/ })).toBeInTheDocument());
    await userEvent.type(input, "Hello{Enter}");

    expect(await screen.findByRole("alert")).toHaveTextContent("The model server is not reachable.");
    expect(input).toHaveValue("Hello");
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });
});

const TURN_CHECKPOINT = checkpointView({ id: "33333333-3333-4333-8333-333333333333", messageId: "u1" });
const TOOL_CHECKPOINT = checkpointView({
  id: "44444444-4444-4444-8444-444444444444",
  kind: "tool",
  label: "Before: Edit parser.ts",
  messageId: null,
  toolCallId: "call-1",
});

/** A saved conversation with a finished edit, checkpoints for both, and git changes. */
const saved: ConversationDetail = conversationDetail({
  id: ID,
  title: "Fix the parser",
  messages: [
    { id: "u1", role: "user", content: "Fix the parser", createdAt: NOW },
    {
      id: "a1",
      role: "assistant",
      content: "Done.",
      reasoning: "",
      toolCalls: [
        {
          id: "call-1",
          name: "edit_file",
          title: "Edit file",
          arguments: '{"path":"parser.ts","old_string":"a","new_string":"b"}',
          summary: "Edit parser.ts",
          risk: "write",
          status: "ok",
          output: "Edited parser.ts",
        },
      ],
      model: "qwen3",
      interrupted: false,
      createdAt: NOW,
    },
  ],
  workspace: workspaceInfo({ mode: "worktree", branch: "tatvam/fix-parser", baseBranch: "main" }),
  checkpoints: [TURN_CHECKPOINT, TOOL_CHECKPOINT],
});

type Routes = {
  workspace?: DefaultWorkspaceView | null;
  conversation?: ConversationDetail;
  remote?: boolean;
};

describe("AgentApp workspace features", () => {
  const fetchMock = vi.fn<typeof fetch>();

  function route({ workspace = null, conversation = saved, remote = false }: Routes = {}) {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.startsWith("/api/models?provider=ollama")) return json({ provider: "ollama", state: "ready", models: ["qwen3"] });
      if (url.startsWith("/api/models?provider=gpu")) return json({ provider: "gpu", state: "unconfigured", models: [] });
      if (url === "/api/conversations") return json({ conversations: [] });
      if (url === "/api/auth/session") return json({ remote, authenticated: remote });
      if (url === "/api/auth/logout") return new Response(null, { status: 204 });
      if (url === "/api/workspace") return workspace ? json(workspace) : json({ error: "Not found" }, 404);
      if (url === `/api/conversations/${ID}`) return json(conversation);
      if (url === `/api/conversations/${ID}/changes`) return json(gitChanges());
      if (url === `/api/conversations/${ID}/checkpoints` && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { rewindConversation: boolean };
        return json({
          message: body.rewindConversation ? "Rewound to before your message." : "Files restored.",
          restoredPrompt: body.rewindConversation ? "Fix the parser" : null,
        });
      }
      if (url === "/api/agent" && init?.method === "POST") {
        return new Response(ndjson(events), { headers: { "Content-Type": "application/x-ndjson" } });
      }
      return json({ error: "Not found" }, 404);
    });
  }

  /** JSON bodies POSTed to a URL, in order. */
  const posted = (url: string) =>
    fetchMock.mock.calls
      .filter(([target, init]) => target === url && init?.method === "POST")
      .map(([, init]) => JSON.parse(String(init?.body)));

  const callsTo = (url: string) => fetchMock.mock.calls.filter(([target]) => target === url).length;

  beforeEach(() => {
    window.localStorage.clear();
    window.history.replaceState(null, "", "/");
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    fetchMock.mockReset();
    vi.mocked(navigateTo).mockClear();
  });

  async function startNewTask() {
    render(<AgentApp initialConversationId={null} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /Model: qwen3/ })).toBeInTheDocument());
  }

  it("offers worktree isolation for a new task in a git workspace and sends the choice", async () => {
    route({ workspace: { path: "/workspace", isGitRepo: true, branch: "main" } });
    await startNewTask();
    const group = await screen.findByRole("radiogroup", { name: "Where the task works" });
    expect(group).toHaveAccessibleDescription("Worktree runs the task on its own git branch in a separate folder.");
    expect(within(group).getByRole("radio", { name: "Shared" })).toHaveAttribute("aria-checked", "true");

    await userEvent.click(within(group).getByRole("radio", { name: "Worktree" }));
    expect(within(group).getByRole("radio", { name: "Worktree" })).toHaveAttribute("aria-checked", "true");
    expect(JSON.parse(window.localStorage.getItem("tatvam.preferences.v1") ?? "{}")).toMatchObject({
      isolation: "worktree",
    });

    await userEvent.type(screen.getByRole("textbox", { name: "Message" }), "Fix the parser{Enter}");
    await waitFor(() => expect(posted("/api/agent")).toHaveLength(1));
    expect(posted("/api/agent")[0]).toEqual({
      provider: "ollama",
      model: "qwen3",
      permissionMode: "ask",
      content: "Fix the parser",
      isolation: "worktree",
    });
    // Once the conversation exists the choice is fixed, so the control goes away.
    await waitFor(() =>
      expect(screen.queryByRole("radiogroup", { name: "Where the task works" })).not.toBeInTheDocument(),
    );
  });

  it("does not offer isolation outside a git workspace", async () => {
    route({ workspace: { path: "/workspace", isGitRepo: false, branch: null } });
    await startNewTask();
    await waitFor(() => expect(callsTo("/api/workspace")).toBe(1));
    expect(screen.queryByRole("radiogroup", { name: "Where the task works" })).not.toBeInTheDocument();

    await userEvent.type(screen.getByRole("textbox", { name: "Message" }), "Hi{Enter}");
    await waitFor(() => expect(posted("/api/agent")).toHaveLength(1));
    expect(posted("/api/agent")[0]).not.toHaveProperty("isolation");
  });

  it("does not offer isolation in an existing conversation", async () => {
    route({ workspace: { path: "/workspace", isGitRepo: true, branch: "main" } });
    render(<AgentApp initialConversationId={ID} />);
    expect(await screen.findByRole("heading", { level: 1, name: "Fix the parser" })).toBeInTheDocument();
    expect(screen.queryByRole("radiogroup", { name: "Where the task works" })).not.toBeInTheDocument();
    expect(callsTo("/api/workspace")).toBe(0);
  });

  it("shows the worktree branch and the size of the changes in the header", async () => {
    route();
    render(<AgentApp initialConversationId={ID} />);
    expect(await screen.findByText("tatvam/fix-parser")).toBeInTheDocument();
    const changes = await screen.findByRole("button", { name: "Changes, 2 added, 1 removed" });
    expect(changes).toHaveAttribute("aria-expanded", "false");

    const before = callsTo(`/api/conversations/${ID}/changes`);
    await userEvent.click(changes);
    expect(screen.getByRole("complementary", { name: "Changes" })).toBeInTheDocument();
    expect(changes).toHaveAttribute("aria-expanded", "true");
    // Opening the panel refetches.
    expect(callsTo(`/api/conversations/${ID}/changes`)).toBe(before + 1);

    await userEvent.click(screen.getByRole("button", { name: "Close changes" }));
    expect(screen.queryByRole("complementary", { name: "Changes" })).not.toBeInTheDocument();
    expect(changes).toHaveFocus();
  });

  it("rewinds files and conversation from a user message and puts the message back in the composer", async () => {
    route();
    render(<AgentApp initialConversationId={ID} />);
    await userEvent.click(await screen.findByRole("button", { name: "Rewind to here" }));
    const dialog = screen.getByRole("dialog", { name: "Rewind to here" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Restore files and conversation" }));

    expect(posted(`/api/conversations/${ID}/checkpoints`)).toEqual([
      { checkpointId: TURN_CHECKPOINT.id, rewindConversation: true },
    ]);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const input = screen.getByRole("textbox", { name: "Message" });
    expect(input).toHaveValue("Fix the parser");
    await waitFor(() => expect(input).toHaveFocus());
    expect(screen.getByText("Rewound to before your message.")).toBeInTheDocument();
  });

  it("restores files only from a user message and leaves the composer alone", async () => {
    route();
    render(<AgentApp initialConversationId={ID} />);
    await userEvent.click(await screen.findByRole("button", { name: "Rewind to here" }));
    const loadsBefore = callsTo(`/api/conversations/${ID}`);
    await userEvent.click(screen.getByRole("button", { name: "Restore files only" }));

    expect(posted(`/api/conversations/${ID}/checkpoints`)).toEqual([
      { checkpointId: TURN_CHECKPOINT.id, rewindConversation: false },
    ]);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue("");
    // The conversation is refetched after a restore.
    await waitFor(() => expect(callsTo(`/api/conversations/${ID}`)).toBe(loadsBefore + 1));
  });

  it("restores files to before a tool call from its card", async () => {
    route();
    render(<AgentApp initialConversationId={ID} />);
    await userEvent.click(await screen.findByRole("button", { name: "Restore files to before this" }));
    const dialog = screen.getByRole("dialog", { name: "Restore files" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Restore files" }));
    expect(posted(`/api/conversations/${ID}/checkpoints`)).toEqual([
      { checkpointId: TOOL_CHECKPOINT.id, rewindConversation: false },
    ]);
  });

  it("says when the task is still running elsewhere and refreshes on request", async () => {
    route({ conversation: { ...saved, running: true } });
    render(<AgentApp initialConversationId={ID} />);
    expect(await screen.findByText("This task is still running in another tab or session.")).toBeInTheDocument();
    route({ conversation: { ...saved, running: false } });
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() =>
      expect(screen.queryByText("This task is still running in another tab or session.")).not.toBeInTheDocument(),
    );
  });

  it("offers Sign out for a remote session", async () => {
    route({ remote: true });
    await startNewTask();
    await userEvent.click(await screen.findByRole("button", { name: "Sign out" }));
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/logout", expect.objectContaining({ method: "POST" }));
    await waitFor(() => expect(navigateTo).toHaveBeenCalledWith("/login"));
  });

  it("has no Sign out on a local session", async () => {
    route({ remote: false });
    await startNewTask();
    await waitFor(() => expect(callsTo("/api/auth/session")).toBe(1));
    expect(screen.queryByRole("button", { name: "Sign out" })).not.toBeInTheDocument();
  });
});
