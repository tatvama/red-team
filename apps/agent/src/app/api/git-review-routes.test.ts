// @vitest-environment node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as restore } from "@/app/api/conversations/[id]/checkpoints/route";
import { GET as changes } from "@/app/api/conversations/[id]/changes/route";
import { POST as gitAction } from "@/app/api/conversations/[id]/git/route";
import { GET as workspaceRoute } from "@/app/api/workspace/route";
import type { DefaultWorkspaceView, GitChanges } from "@/lib/contract";
import { finishRun, tryStartRun } from "@/lib/server/agent";
import { createCheckpoint } from "@/lib/server/checkpoints";
import { closeDb, createConversation, getConversation, setConversationWorkspace, type ConversationRow } from "@/lib/server/db";

// Git review and checkpoint routes, through the real handlers against a temporary repository.

// Real git processes are slow to start on Windows, especially when test files run in parallel.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let root: string;
let repo: string;

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

const base = "http://127.0.0.1:3000";
const get = (url: string, headers: Record<string, string> = {}) => new Request(base + url, { headers });
const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(base + url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const unknownId = "00000000-0000-4000-8000-000000000000";

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tatvam-git-routes-"));
  repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  const globalConfig = path.join(root, "global.gitconfig");
  fs.writeFileSync(globalConfig, "");
  vi.stubEnv("GIT_CONFIG_GLOBAL", globalConfig);
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  vi.stubEnv("DATA_DIR", path.join(root, "data"));
  vi.stubEnv("WORKSPACE_DIR", repo);
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Test User");
  git("config", "user.email", "test@example.com");
  fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
  git("add", "-A");
  git("commit", "-q", "-m", "Initial");
});

afterEach(() => {
  closeDb();
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function sharedTask(): ConversationRow {
  const row = createConversation({ title: "Task", provider: "ollama", model: "m", permissionMode: "ask" });
  setConversationWorkspace(row.id, { mode: "shared", path: null, branch: "main", baseBranch: null, baseCommit: git("rev-parse", "HEAD") });
  return getConversation(row.id)!;
}

async function errorOf(response: Response) {
  return ((await response.json()) as { error: string }).error;
}

describe("GET /api/workspace", () => {
  it("describes the default workspace", async () => {
    const response = await workspaceRoute(get("/api/workspace"));
    expect(response.status).toBe(200);
    expect((await response.json()) as DefaultWorkspaceView).toEqual({ path: repo, isGitRepo: true, branch: "main" });
  });

  it("refuses cross-origin requests", async () => {
    const response = await workspaceRoute(get("/api/workspace", { origin: "https://evil.example" }));
    expect(response.status).toBe(403);
  });
});

describe("GET /api/conversations/[id]/changes", () => {
  it("returns 404 for invalid and unknown ids", async () => {
    expect((await changes(get("/x"), params("nope"))).status).toBe(404);
    expect((await changes(get("/x"), params(unknownId))).status).toBe(404);
  });

  it("returns the task's changes", async () => {
    const task = sharedTask();
    fs.writeFileSync(path.join(repo, "a.txt"), "two\n");
    const response = await changes(get("/x"), params(task.id));
    expect(response.status).toBe(200);
    const body = (await response.json()) as GitChanges;
    expect(body.available).toBe(true);
    expect(body.files.map((file) => [file.path, file.additions, file.deletions])).toEqual([["a.txt", 1, 1]]);
  });
});

describe("POST /api/conversations/[id]/git", () => {
  it("returns 404, 400 and 409 for bad requests", async () => {
    expect((await gitAction(post("/x", { action: "push" }), params("nope"))).status).toBe(404);
    expect((await gitAction(post("/x", { action: "push" }), params(unknownId))).status).toBe(404);
    const task = sharedTask();
    expect((await gitAction(post("/x", { action: "rebase" }), params(task.id))).status).toBe(400);
    expect((await gitAction(post("/x", { action: "commit", message: "" }), params(task.id))).status).toBe(400);
    expect((await gitAction(post("/x", "{not json"), params(task.id))).status).toBe(400);

    // Repository state that blocks the action.
    const empty = await gitAction(post("/x", { action: "commit", message: "Nothing" }), params(task.id));
    expect(empty.status).toBe(409);
    expect(await errorOf(empty)).toBe("There are no changes to commit.");
    // Actions that only make sense for worktree tasks.
    const merge = await gitAction(post("/x", { action: "merge" }), params(task.id));
    expect(merge.status).toBe(400);

    tryStartRun(task.id);
    try {
      const running = await gitAction(post("/x", { action: "commit", message: "Work" }), params(task.id));
      expect(running.status).toBe(409);
      expect(await errorOf(running)).toContain("Wait for the task to finish");
    } finally {
      finishRun(task.id);
    }
  });

  it("commits the workspace", async () => {
    const task = sharedTask();
    fs.writeFileSync(path.join(repo, "b.txt"), "new\n");
    const response = await gitAction(post("/x", { action: "commit", message: "Add b" }), params(task.id));
    expect(response.status).toBe(200);
    expect(((await response.json()) as { message: string }).message).toMatch(/^Committed [0-9a-f]+: Add b$/);
    expect(git("log", "-1", "--format=%s")).toBe("Add b");
  });
});

describe("POST /api/conversations/[id]/checkpoints", () => {
  it("returns 404, 400 and 409 for bad requests", async () => {
    const body = { checkpointId: unknownId, rewindConversation: false };
    expect((await restore(post("/x", body), params("nope"))).status).toBe(404);
    expect((await restore(post("/x", body), params(unknownId))).status).toBe(404);
    const task = sharedTask();
    expect((await restore(post("/x", { checkpointId: "x", rewindConversation: false }), params(task.id))).status).toBe(400);
    expect((await restore(post("/x", { ...body, extra: true }), params(task.id))).status).toBe(400);
    // Unknown checkpoint in a known conversation.
    expect((await restore(post("/x", body), params(task.id))).status).toBe(404);
    // Rewinding needs a turn checkpoint.
    const tool = await createCheckpoint({ conversationId: task.id, workspace: repo, kind: "tool", label: "Edit" });
    const rewind = await restore(post("/x", { checkpointId: tool!.id, rewindConversation: true }), params(task.id));
    expect(rewind.status).toBe(400);

    tryStartRun(task.id);
    try {
      expect((await restore(post("/x", { checkpointId: tool!.id, rewindConversation: false }), params(task.id))).status).toBe(409);
    } finally {
      finishRun(task.id);
    }
  });

  it("restores the files", async () => {
    const task = sharedTask();
    const checkpoint = await createCheckpoint({ conversationId: task.id, workspace: repo, kind: "tool", label: "Before edit" });
    fs.writeFileSync(path.join(repo, "a.txt"), "edited\n");
    fs.writeFileSync(path.join(repo, "later.txt"), "later\n");
    const response = await restore(post("/x", { checkpointId: checkpoint!.id, rewindConversation: false }), params(task.id));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ message: 'Restored the files to "Before edit".', restoredPrompt: null });
    expect(fs.readFileSync(path.join(repo, "a.txt"), "utf8")).toBe("one\n");
    expect(fs.existsSync(path.join(repo, "later.txt"))).toBe(false);
  });
});
