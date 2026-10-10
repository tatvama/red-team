// @vitest-environment node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CheckpointError, checkpointViews, createCheckpoint, removeCheckpointStore, restoreCheckpoint } from "./checkpoints";
import {
  appendMessage,
  closeDb,
  createConversation,
  getConversation,
  listCheckpointRecords,
  listMessages,
  type ConversationRow,
} from "./db";

// Real git processes are slow to start on Windows, especially when test files run in parallel.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let root: string;
let data: string;
let workspace: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } }).trim();
}

function write(relative: string, content: string) {
  const file = path.join(workspace, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

const read = (relative: string) => fs.readFileSync(path.join(workspace, relative), "utf8");
const exists = (relative: string) => fs.existsSync(path.join(workspace, relative));

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tatvam-checkpoints-"));
  data = path.join(root, "data");
  workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  const globalConfig = path.join(root, "global.gitconfig");
  fs.writeFileSync(globalConfig, "");
  vi.stubEnv("GIT_CONFIG_GLOBAL", globalConfig);
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  vi.stubEnv("DATA_DIR", data);
  vi.stubEnv("WORKSPACE_DIR", workspace);
});

afterEach(() => {
  closeDb();
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function newConversation(): ConversationRow {
  const row = createConversation({ title: "Task", provider: "ollama", model: "m", permissionMode: "ask" });
  return getConversation(row.id)!;
}

async function checkpoint(conversation: ConversationRow, label: string, extra: Partial<Parameters<typeof createCheckpoint>[0]> = {}) {
  const view = await createCheckpoint({ conversationId: conversation.id, workspace, kind: "tool", label, ...extra });
  expect(view).not.toBeNull();
  return view!;
}

describe("checkpoints", () => {
  it("snapshots, then restores edited files and removes files created later", async () => {
    const conversation = newConversation();
    write("a.txt", "original\n");
    write("src/keep.ts", "keep\n");
    write("debug.log", "log 1\n");
    write("node_modules/pkg/index.js", "dep 1\n");
    write(".gitignore", "secret.env\n");
    write("secret.env", "TOKEN=1\n");
    const view = await checkpoint(conversation, "Before edit", { toolCallId: "call_1" });
    expect(view).toMatchObject({ kind: "tool", label: "Before edit", toolCallId: "call_1", messageId: null });
    expect(fs.existsSync(path.join(data, "checkpoints", `${conversation.id}.git`, "HEAD"))).toBe(true);

    write("a.txt", "edited\n");
    write("src/new/deep.ts", "new\n");
    fs.rmSync(path.join(workspace, "src", "keep.ts"));
    write("debug.log", "log 2\n");
    write("node_modules/pkg/index.js", "dep 2\n");
    write("secret.env", "TOKEN=2\n");

    const result = await restoreCheckpoint(conversation, { checkpointId: view.id, rewindConversation: false });
    expect(result).toEqual({ message: 'Restored the files to "Before edit".', restoredPrompt: null });
    expect(read("a.txt")).toBe("original\n");
    expect(read("src/keep.ts")).toBe("keep\n");
    expect(exists("src/new")).toBe(false);
    // Ignored and excluded files are never snapshotted, so a restore leaves them alone.
    expect(read("debug.log")).toBe("log 2\n");
    expect(read("node_modules/pkg/index.js")).toBe("dep 2\n");
    expect(read("secret.env")).toBe("TOKEN=2\n");
    expect(checkpointViews(conversation.id).map((item) => [item.kind, item.label])).toEqual([
      ["tool", "Before edit"],
      ["tool", "Before restore"],
    ]);

    // Undo the restore with the safety checkpoint it took.
    const safety = checkpointViews(conversation.id)[1];
    await restoreCheckpoint(conversation, { checkpointId: safety.id, rewindConversation: false });
    expect(read("a.txt")).toBe("edited\n");
    expect(read("src/new/deep.ts")).toBe("new\n");
    expect(exists("src/keep.ts")).toBe(false);
  });

  it("keeps file bytes exactly, including CRLF line endings", async () => {
    const conversation = newConversation();
    write(".gitattributes", "* text=auto eol=lf\n");
    write("win.txt", "a\r\nb\r\n");
    const view = await checkpoint(conversation, "Start");
    write("win.txt", "changed\n");
    await restoreCheckpoint(conversation, { checkpointId: view.id, rewindConversation: false });
    expect(read("win.txt")).toBe("a\r\nb\r\n");
  });

  it("rewinds the conversation from a turn checkpoint and returns the prompt", async () => {
    const conversation = newConversation();
    const assistant = { role: "assistant" as const, reasoning: "", toolCalls: [], model: "m", interrupted: false };
    appendMessage(conversation.id, { role: "user", content: "first" });
    appendMessage(conversation.id, { ...assistant, content: "reply one" });
    write("a.txt", "v1\n");
    const second = appendMessage(conversation.id, { role: "user", content: "second prompt" });
    const turn = await checkpoint(conversation, "second prompt", { kind: "turn", messageId: second.id, messageSeq: second.seq });
    appendMessage(conversation.id, { ...assistant, content: "reply two" });
    await checkpoint(conversation, "Edit a.txt", { toolCallId: "call_2" });
    write("a.txt", "v2\n");

    const result = await restoreCheckpoint(conversation, { checkpointId: turn.id, rewindConversation: true });
    expect(result).toEqual({
      message: 'Restored the files and rewound the conversation to "second prompt".',
      restoredPrompt: "second prompt",
    });
    expect(read("a.txt")).toBe("v1\n");
    expect(listMessages(conversation.id).map((message) => message.content)).toEqual(["first", "reply one"]);
    expect(checkpointViews(conversation.id).map((item) => item.label)).toEqual(["second prompt", "Before restore"]);
  });

  it("refuses to rewind from a tool checkpoint or restore an unknown one", async () => {
    const conversation = newConversation();
    write("a.txt", "v1\n");
    const tool = await checkpoint(conversation, "Edit");
    write("a.txt", "v2\n");
    const refused = await restoreCheckpoint(conversation, { checkpointId: tool.id, rewindConversation: true }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(CheckpointError);
    expect((refused as CheckpointError).status).toBe(400);
    expect(read("a.txt")).toBe("v2\n");
    expect(checkpointViews(conversation.id)).toHaveLength(1);

    const missing = await restoreCheckpoint(conversation, {
      checkpointId: "00000000-0000-4000-8000-000000000000",
      rewindConversation: false,
    }).catch((error: unknown) => error);
    expect(missing).toBeInstanceOf(CheckpointError);
    expect((missing as CheckpointError).status).toBe(404);
  });

  it("returns null when the workspace is missing", async () => {
    const conversation = newConversation();
    const view = await createCheckpoint({
      conversationId: conversation.id,
      workspace: path.join(root, "missing"),
      kind: "turn",
      label: "Hello",
    });
    expect(view).toBeNull();
    expect(checkpointViews(conversation.id)).toEqual([]);
    expect(await createCheckpoint({ conversationId: "not-a-uuid", workspace, kind: "tool", label: "x" })).toBeNull();
  });

  it("never changes the user's repository HEAD, index, branches or status", async () => {
    git(workspace, "init", "-q", "-b", "main");
    git(workspace, "config", "user.name", "Test User");
    git(workspace, "config", "user.email", "test@example.com");
    write("tracked.txt", "one\n");
    git(workspace, "add", "-A");
    git(workspace, "commit", "-q", "-m", "Initial");
    write("staged.txt", "staged\n");
    git(workspace, "add", "staged.txt");
    write("tracked.txt", "one\nunstaged\n");
    write("untracked.txt", "new\n");
    const indexFile = path.join(workspace, ".git", "index");
    const state = () => ({
      head: git(workspace, "rev-parse", "HEAD"),
      index: createHash("sha256").update(fs.readFileSync(indexFile)).digest("hex"),
      status: git(workspace, "status", "--porcelain"),
      refs: git(workspace, "for-each-ref"),
      objects: git(workspace, "count-objects"),
    });
    const before = state();

    const conversation = newConversation();
    await checkpoint(conversation, "One");
    await checkpoint(conversation, "Two");
    expect(state()).toEqual(before);
    // The shadow repository did not record the user's .git folder.
    const shadow = path.join(data, "checkpoints", `${conversation.id}.git`);
    const files = git(workspace, `--git-dir=${shadow}`, "ls-tree", "-r", "--name-only", "HEAD").split("\n");
    expect(files.sort()).toEqual(["staged.txt", "tracked.txt", "untracked.txt"]);
  });

  it("serializes concurrent snapshots and removes the store", async () => {
    const conversation = newConversation();
    write("a.txt", "a\n");
    const views = await Promise.all([1, 2, 3].map((n) => createCheckpoint({ conversationId: conversation.id, workspace, kind: "tool", label: `Step ${n}` })));
    expect(views.every((view) => view !== null)).toBe(true);
    expect(new Set(listCheckpointRecords(conversation.id).map((record) => record.commitSha)).size).toBe(3);

    await removeCheckpointStore(conversation.id);
    expect(fs.existsSync(path.join(data, "checkpoints", `${conversation.id}.git`))).toBe(false);
    await removeCheckpointStore(conversation.id);
  });
});
