// @vitest-environment node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as agent } from "@/app/api/agent/route";
import { GET as changes } from "@/app/api/conversations/[id]/changes/route";
import { POST as restore } from "@/app/api/conversations/[id]/checkpoints/route";
import { POST as gitAction } from "@/app/api/conversations/[id]/git/route";
import { GET as getConversation } from "@/app/api/conversations/[id]/route";
import type { AgentEvent, ConversationDetail, GitChanges, RestoreCheckpointResult } from "@/lib/contract";
import { closeDb } from "./db";

// The whole feature set wired together through the real route handlers: a worktree task, automatic
// checkpoints, the diff, rewind, sub-agents and discard. Only the model server is scripted.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let root: string;
let repo: string;
let replies: string[];
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "tatvam-int-"));
  repo = path.join(root, "repo");
  mkdirSync(repo);
  git("init", "-b", "main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.com");
  git("config", "core.autocrlf", "false");
  writeFileSync(path.join(repo, "README.md"), "# Project\n");
  git("add", "-A");
  git("commit", "-m", "init");
  vi.stubEnv("DATA_DIR", path.join(root, "data"));
  vi.stubEnv("WORKSPACE_DIR", repo);
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
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

const sse = (...deltas: object[]) =>
  deltas.map((delta) => `data: ${JSON.stringify({ choices: [{ index: 0, delta }] })}\n\n`).join("") + "data: [DONE]\n\n";
const toolCall = (id: string, name: string, args: object) =>
  sse({ tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] });

const base = "http://127.0.0.1:3000";
const post = (url: string, body: unknown) =>
  new Request(base + url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const run = { provider: "ollama", model: "m" };

async function events(response: Response): Promise<AgentEvent[]> {
  expect(response.status).toBe(200);
  return (await response.text()).trim().split("\n").map((line) => JSON.parse(line) as AgentEvent);
}
async function detail(id: string) {
  return (await (await getConversation(new Request(base), params(id))).json()) as ConversationDetail;
}

describe("worktree task end to end", () => {
  it("edits on its own branch with checkpoints, shows the diff, rewinds, then refuses to run after discard", async () => {
    replies.push(toolCall("w1", "write_file", { path: "notes.txt", content: "hello\n" }), sse({ content: "Wrote it." }));
    const stream = await events(
      await agent(post("/api/agent", { ...run, permissionMode: "accept_edits", isolation: "worktree", content: "write notes" })),
    );
    const id = stream[0].type === "conversation" ? stream[0].conversation.id : "";
    const checkpoints = stream.flatMap((event) => (event.type === "checkpoint" ? [event.checkpoint] : []));
    expect(checkpoints.map((checkpoint) => checkpoint.kind)).toEqual(["turn", "tool"]);
    expect(stream).toContainEqual(expect.objectContaining({ type: "tool_result", callId: "w1", status: "ok" }));

    const view = await detail(id);
    expect(view.workspace).toMatchObject({ mode: "worktree", isGitRepo: true, baseBranch: "main" });
    expect(view.workspace.branch).toMatch(/^tatvam\//);
    expect(view.checkpoints).toHaveLength(2);
    // The edit landed in the task's worktree, not in the user's checkout.
    expect(readFileSync(path.join(view.workspace.path, "notes.txt"), "utf8")).toBe("hello\n");
    expect(existsSync(path.join(repo, "notes.txt"))).toBe(false);

    const diff = (await (await changes(new Request(base), params(id))).json()) as GitChanges;
    expect(diff.available).toBe(true);
    expect(diff.files).toEqual([expect.objectContaining({ path: "notes.txt", status: "added", additions: 1 })]);

    const turn = view.checkpoints.find((checkpoint) => checkpoint.kind === "turn")!;
    const rewound = await restore(post(`/api/conversations/${id}/checkpoints`, { checkpointId: turn.id, rewindConversation: true }), params(id));
    expect(rewound.status).toBe(200);
    expect(((await rewound.json()) as RestoreCheckpointResult).restoredPrompt).toBe("write notes");
    expect(existsSync(path.join(view.workspace.path, "notes.txt"))).toBe(false);
    expect((await detail(id)).messages).toEqual([]);

    const discarded = await gitAction(post(`/api/conversations/${id}/git`, { action: "discard" }), params(id));
    expect(discarded.status).toBe(200);
    const after = await agent(post("/api/agent", { ...run, permissionMode: "ask", conversationId: id, content: "again" }));
    expect(after.status).toBe(409);
    expect(git("branch", "--list", "tatvam/*")).toBe("");
  });

  it("refuses worktree isolation when the workspace is not a git repository, leaving no conversation behind", async () => {
    const plain = path.join(root, "plain");
    mkdirSync(plain);
    vi.stubEnv("WORKSPACE_DIR", plain);
    const response = await agent(post("/api/agent", { ...run, permissionMode: "ask", isolation: "worktree", content: "hi" }));
    expect(response.status).toBe(400);
    const { GET: list } = await import("@/app/api/conversations/route");
    const body = (await (await list(new Request(base))).json()) as { conversations: unknown[] };
    expect(body.conversations).toEqual([]);
  });

  it("records a shared-mode baseline so the diff shows only this task's changes", async () => {
    replies.push(toolCall("w1", "write_file", { path: "a.txt", content: "a\n" }), sse({ content: "Done." }));
    const stream = await events(await agent(post("/api/agent", { ...run, permissionMode: "full_auto", content: "write a" })));
    const id = stream[0].type === "conversation" ? stream[0].conversation.id : "";
    const view = await detail(id);
    expect(view.workspace).toMatchObject({ mode: "shared", isGitRepo: true, branch: "main", baseCommit: git("rev-parse", "HEAD") });
    const diff = (await (await changes(new Request(base), params(id))).json()) as GitChanges;
    expect(diff.files.map((file) => file.path)).toEqual(["a.txt"]);
    // Checkpoints live in a shadow repository: the user's index and history are untouched.
    expect(git("status", "--porcelain")).toBe("?? a.txt");
    expect(git("rev-list", "--count", "HEAD")).toBe("1");
  });

  it("runs sub-agents from the main agent and keeps their reports on the conversation", async () => {
    replies.push(
      toolCall("d1", "delegate_tasks", {
        tasks: [
          { role: "reviewer", task: "Review the README" },
          { role: "researcher", task: "Summarize the project" },
        ],
      }),
      sse({ content: "Sub-agent report." }),
      sse({ content: "Sub-agent report." }),
      sse({ content: "Both sub-agents are done." }),
    );
    const stream = await events(await agent(post("/api/agent", { ...run, permissionMode: "ask", content: "delegate" })));
    const id = stream[0].type === "conversation" ? stream[0].conversation.id : "";
    const updates = stream.flatMap((event) => (event.type === "subagent" ? [event.subagent] : []));
    expect(new Set(updates.map((update) => update.role))).toEqual(new Set(["reviewer", "researcher"]));
    expect(stream).toContainEqual(expect.objectContaining({ type: "tool_result", callId: "d1", status: "ok" }));
    expect(stream.at(-1)).toEqual({ type: "done", reason: "complete" });
    const view = await detail(id);
    expect(view.subagents.map((subagent) => [subagent.status, subagent.report])).toEqual([
      ["done", "Sub-agent report."],
      ["done", "Sub-agent report."],
    ]);
  });
});
