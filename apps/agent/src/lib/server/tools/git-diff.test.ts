// @vitest-environment node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDb, createConversation, setConversationWorkspace } from "../db";
import { gitDiffTool } from "./git-diff";

// Real git processes are slow to start on Windows, especially when test files run in parallel.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let root: string;
let workspace: string;

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: workspace, encoding: "utf8" }).trim();
}

function write(relative: string, content: string) {
  const file = path.join(workspace, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

const run = (input: { path?: string }, conversationId = "test") =>
  gitDiffTool.run(gitDiffTool.schema.parse(input), { signal: new AbortController().signal, conversationId });

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tatvam-git-diff-"));
  workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace);
  const globalConfig = path.join(root, "global.gitconfig");
  fs.writeFileSync(globalConfig, "");
  vi.stubEnv("GIT_CONFIG_GLOBAL", globalConfig);
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  vi.stubEnv("DATA_DIR", path.join(root, "data"));
  vi.stubEnv("WORKSPACE_DIR", workspace);
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Test User");
  git("config", "user.email", "test@example.com");
  git("config", "core.autocrlf", "false");
  write("a.txt", "one\ntwo\n");
  write("src/b.ts", "export const b = 1;\n");
  git("add", "-A");
  git("commit", "-q", "-m", "Initial");
});

afterEach(() => {
  closeDb();
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("git_diff", () => {
  it("is a read-only, automatic tool with a strict schema", () => {
    expect(gitDiffTool).toMatchObject({ name: "git_diff", title: "Show changes", risk: "read", defaultPolicy: "auto" });
    expect(gitDiffTool.description).toContain("changed in this task");
    expect(gitDiffTool.schema.safeParse({ path: "a.txt", extra: 1 }).success).toBe(false);
    expect(gitDiffTool.summarize({})).toBe("Show changes in the workspace");
  });

  it("shows tracked and untracked changes against HEAD when the task has no starting commit", async () => {
    write("a.txt", "one\nTWO\n");
    write("notes/new.md", "hello\n");
    write("ignored.log", "x\n");
    write(".gitignore", "*.log\n");
    const result = await run({});
    expect(result.status).toBe("ok");
    expect(result.content).toMatch(/^Changes since HEAD \([0-9a-f]{10}\):/);
    expect(result.content).toContain("diff --git a/a.txt b/a.txt");
    expect(result.content).toContain("-two\n+TWO");
    expect(result.content).toContain("diff --git a/notes/new.md b/notes/new.md\nnew file mode 100644");
    expect(result.content).toContain("+hello");
    expect(result.content).not.toContain("ignored.log");
  });

  it("compares with the conversation's starting commit, including commits made since", async () => {
    const base = git("rev-parse", "HEAD");
    const conversation = createConversation({ title: "t", provider: "ollama", model: "m", permissionMode: "ask" });
    setConversationWorkspace(conversation.id, { mode: "shared", path: null, branch: "main", baseBranch: null, baseCommit: base });
    write("src/b.ts", "export const b = 2;\n");
    git("commit", "-q", "-am", "Change b");
    const result = await run({}, conversation.id);
    expect(result.content).toContain("since the commit this task started from");
    expect(result.content).toContain("+export const b = 2;");
  });

  it("limits the diff to a path and refuses paths outside the workspace", async () => {
    write("a.txt", "changed\n");
    write("src/b.ts", "changed\n");
    const scoped = await run({ path: "src" });
    expect(scoped.content).toContain("diff --git a/src/b.ts");
    expect(scoped.content).not.toContain("a.txt");
    expect(await run({ path: "src/b.ts" })).toMatchObject({ status: "ok" });
    expect((await run({ path: "../outside" })).status).toBe("error");
  });

  it("says when nothing changed and when the workspace is not a repository", async () => {
    expect((await run({})).content).toMatch(/^No changes since HEAD/);
    fs.rmSync(path.join(workspace, ".git"), { recursive: true, force: true });
    const result = await run({});
    expect(result).toEqual({ status: "error", content: "The workspace is not a git repository, so there are no changes to show." });
  });
});
