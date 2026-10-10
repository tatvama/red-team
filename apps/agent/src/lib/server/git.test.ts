// @vitest-environment node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Isolation } from "@/lib/contract";
import { closeDb, createConversation, getConversation, setConversationWorkspace, type ConversationRow } from "./db";
import {
  GitError,
  branchSlug,
  createTaskWorktree,
  describeRemote,
  getChanges,
  inspectWorkspace,
  removeTaskWorktree,
  runGitAction,
  sharedBaseline,
  workspaceInfo,
} from "./git";

// Real git processes are slow to start on Windows, especially when test files run in parallel.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let root: string;
let repo: string;
let data: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } }).trim();
}

function write(dir: string, relative: string, content: string | Buffer) {
  const file = path.join(dir, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

const read = (dir: string, relative: string) => fs.readFileSync(path.join(dir, relative), "utf8");

function initRepo(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.name", "Test User");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "core.autocrlf", "false");
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tatvam-git-"));
  data = path.join(root, "data");
  repo = path.join(root, "repo");
  // Isolate from the developer's global and system git config (hooks, signing, LFS filters).
  const globalConfig = path.join(root, "global.gitconfig");
  fs.writeFileSync(globalConfig, "");
  vi.stubEnv("GIT_CONFIG_GLOBAL", globalConfig);
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  vi.stubEnv("DATA_DIR", data);
  vi.stubEnv("WORKSPACE_DIR", repo);
  vi.stubEnv("GITHUB_TOKEN", "");
  initRepo(repo);
  write(repo, "a.txt", "one\ntwo\nthree\nfour\nfive\nsix\n");
  write(repo, "del.txt", "delete me\n");
  write(repo, "old-name.txt", Array.from({ length: 10 }, (_, index) => `line ${index + 1} of a file that moves\n`).join(""));
  write(repo, "img.bin", Buffer.from([0, 1, 2, 3]));
  write(repo, ".gitignore", "*.log\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "Initial commit");
});

afterEach(() => {
  closeDb();
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function conversationWith(workspace: {
  mode?: Isolation;
  path?: string | null;
  branch?: string | null;
  baseBranch?: string | null;
  baseCommit?: string | null;
}): ConversationRow {
  const row = createConversation({ title: "Task", provider: "ollama", model: "m", permissionMode: "ask" });
  setConversationWorkspace(row.id, {
    mode: workspace.mode ?? "shared",
    path: workspace.path ?? null,
    branch: workspace.branch ?? null,
    baseBranch: workspace.baseBranch ?? null,
    baseCommit: workspace.baseCommit ?? null,
  });
  return getConversation(row.id)!;
}

async function worktreeTask(title = "Fix the login bug") {
  const row = createConversation({ title, provider: "ollama", model: "m", permissionMode: "ask" });
  const created = await createTaskWorktree(row.id, title);
  setConversationWorkspace(row.id, { mode: "worktree", path: created.path, branch: created.branch, baseBranch: created.baseBranch, baseCommit: created.baseCommit });
  return { conversation: getConversation(row.id)!, created };
}

async function gitError(promise: Promise<unknown>): Promise<GitError> {
  const error = await promise.then(
    () => null,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(GitError);
  return error as GitError;
}

describe("workspace inspection", () => {
  it("reports the default workspace's repository and branch", async () => {
    expect(await inspectWorkspace(repo)).toEqual({ path: repo, isGitRepo: true, branch: "main" });
    expect(await sharedBaseline(repo)).toEqual({ branch: "main", baseCommit: git(repo, "rev-parse", "HEAD") });
  });

  it("treats plain folders and folders the enclosing repository ignores as not a repository", async () => {
    const plain = path.join(root, "plain");
    fs.mkdirSync(plain);
    expect(await inspectWorkspace(plain)).toEqual({ path: plain, isGitRepo: false, branch: null });
    expect(await sharedBaseline(plain)).toBeNull();
    write(repo, ".gitignore", "*.log\nignored-data/\n");
    const nested = path.join(repo, "ignored-data", "workspace");
    fs.mkdirSync(nested, { recursive: true });
    expect((await inspectWorkspace(nested)).isGitRepo).toBe(false);
    expect((await inspectWorkspace(path.join(root, "missing"))).isGitRepo).toBe(false);
  });

  it("makes branch-safe slugs", () => {
    expect(branchSlug("Fix the login bug!")).toBe("fix-the-login-bug");
    expect(branchSlug("Résumé: ünïcode  ✨ tidy-up")).toBe("resume-unicode-tidy-up");
    expect(branchSlug("✨✨")).toBe("task");
    expect(branchSlug("x".repeat(80))).toHaveLength(40);
  });
});

describe("task worktrees", () => {
  it("creates a worktree on a new branch from the workspace HEAD", async () => {
    const head = git(repo, "rev-parse", "HEAD");
    const { conversation, created } = await worktreeTask("Fix the login bug!");
    expect(created.path).toBe(path.join(data, "worktrees", conversation.id));
    expect(created.branch).toBe(`tatvam/fix-the-login-bug-${conversation.id.slice(0, 6)}`);
    expect(created.baseBranch).toBe("main");
    expect(created.baseCommit).toBe(head);
    const link = path.join(created.path, ".git");
    expect(fs.lstatSync(link).isFile()).toBe(true);
    expect(fs.readFileSync(link, "utf8")).toMatch(/^gitdir: .*\.git[\\/]worktrees[\\/]/);
    expect(git(created.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(created.branch);
    expect(read(created.path, "a.txt")).toBe(read(repo, "a.txt"));
    expect(workspaceInfo(conversation)).toEqual({
      mode: "worktree",
      path: created.path,
      isGitRepo: true,
      branch: created.branch,
      baseBranch: "main",
      baseCommit: head,
    });
  });

  it("refuses to run git where the worktree's .git link was replaced", async () => {
    const { conversation, created } = await worktreeTask();
    const other = path.join(root, "other");
    initRepo(other);
    // Git for Windows marks the link hidden, which Windows refuses to overwrite in place.
    fs.rmSync(path.join(created.path, ".git"));
    fs.writeFileSync(path.join(created.path, ".git"), `gitdir: ${path.join(other, ".git")}\n`);
    const changes = await getChanges(conversation);
    expect(changes.available).toBe(false);
    expect(changes.reason).toContain("does not point into the workspace repository");
    expect((await gitError(runGitAction(conversation, { action: "commit", message: "x" }))).message).toContain("does not point into");

    fs.rmSync(path.join(created.path, ".git"));
    git(created.path, "init", "-q");
    expect((await gitError(runGitAction(conversation, { action: "push" }))).status).toBe(409);
  });

  it("refuses to create a worktree when the workspace is not a repository", async () => {
    const plain = path.join(root, "plain");
    fs.mkdirSync(plain);
    vi.stubEnv("WORKSPACE_DIR", plain);
    const row = createConversation({ title: "x", provider: "ollama", model: "m", permissionMode: "ask" });
    expect((await gitError(createTaskWorktree(row.id, "x"))).message).toContain("not a git repository");
  });
});

describe("changes", () => {
  it("lists modified, added, deleted, renamed and binary files with line numbers", async () => {
    const { conversation, created } = await worktreeTask();
    const dir = created.path;
    fs.renameSync(path.join(dir, "old-name.txt"), path.join(dir, "new-name.txt"));
    await runGitAction(conversation, { action: "commit", message: "Rename the file" });
    write(dir, "a.txt", "one\ntwo\nTHREE\nfour\nfive\nsix\nseven\n");
    fs.rmSync(path.join(dir, "del.txt"));
    write(dir, "new.txt", "hello\nworld\n");
    write(dir, "new.bin", Buffer.from([0, 0, 1]));
    write(dir, "img.bin", Buffer.from([0, 9, 9]));
    write(dir, "debug.log", "ignored\n");

    const changes = await getChanges(conversation);
    expect(changes).toMatchObject({ available: true, ahead: 1, hasUncommitted: true, truncated: false, remote: null, canOpenPullRequest: false });
    expect(changes.files.map((file) => [file.path, file.status, file.oldPath, file.binary])).toEqual([
      ["a.txt", "modified", null, false],
      ["del.txt", "deleted", null, false],
      ["img.bin", "modified", null, true],
      ["new-name.txt", "renamed", "old-name.txt", false],
      ["new.bin", "added", null, true],
      ["new.txt", "added", null, false],
    ]);
    const [a, del, , renamed, , added] = changes.files;
    expect(a.hunks).toHaveLength(1);
    expect(a.hunks[0].header).toBe("@@ -1,6 +1,7 @@");
    expect(a.hunks[0].lines.map((line) => [line.type, line.text, line.oldLine, line.newLine])).toEqual([
      ["context", "one", 1, 1],
      ["context", "two", 2, 2],
      ["del", "three", 3, null],
      ["add", "THREE", null, 3],
      ["context", "four", 4, 4],
      ["context", "five", 5, 5],
      ["context", "six", 6, 6],
      ["add", "seven", null, 7],
    ]);
    expect([del.deletions, del.hunks[0].lines[0]]).toEqual([1, { type: "del", text: "delete me", oldLine: 1, newLine: null }]);
    expect([renamed.additions, renamed.deletions, renamed.hunks]).toEqual([0, 0, []]);
    expect(added.hunks[0].lines).toEqual([
      { type: "add", text: "hello", oldLine: null, newLine: 1 },
      { type: "add", text: "world", oldLine: null, newLine: 2 },
    ]);
    expect([changes.additions, changes.deletions]).toEqual([4, 2]);
    // Reading changes never touched the main checkout.
    expect(git(repo, "status", "--porcelain")).toBe("");
  });

  it("commits, then reports commits ahead and a clean tree", async () => {
    const { conversation, created } = await worktreeTask();
    write(created.path, "notes.md", "# Notes\n");
    expect(await getChanges(conversation)).toMatchObject({ ahead: 0, hasUncommitted: true });

    const result = await runGitAction(conversation, { action: "commit", message: "Add notes\n\nLonger body" });
    expect(result.message).toMatch(/^Committed [0-9a-f]{7,}: Add notes$/);
    const after = await getChanges(conversation);
    expect(after).toMatchObject({ ahead: 1, hasUncommitted: false });
    expect(after.files.map((file) => [file.path, file.status])).toEqual([["notes.md", "added"]]);
    expect(git(created.path, "log", "-1", "--format=%B")).toBe("Add notes\n\nLonger body");

    const nothing = await gitError(runGitAction(conversation, { action: "commit", message: "Again" }));
    expect([nothing.status, nothing.message]).toEqual([409, "There are no changes to commit."]);
  });

  it("explains a missing git identity", async () => {
    const { conversation, created } = await worktreeTask();
    git(repo, "config", "--unset", "user.name");
    git(repo, "config", "--unset", "user.email");
    git(repo, "config", "user.useConfigOnly", "true");
    write(created.path, "x.txt", "x\n");
    expect((await gitError(runGitAction(conversation, { action: "commit", message: "x" }))).message).toContain(
      "Git has no user identity",
    );
  });

  it("works on the shared workspace against the commit the task started from", async () => {
    const baseline = (await sharedBaseline(repo))!;
    const conversation = conversationWith({ mode: "shared", branch: baseline.branch, baseCommit: baseline.baseCommit });
    write(repo, "a.txt", "changed\n");
    const changes = await getChanges(conversation);
    expect(changes.available).toBe(true);
    expect(changes.workspace).toMatchObject({ mode: "shared", path: repo, isGitRepo: true });
    expect(changes.files.map((file) => file.path)).toEqual(["a.txt"]);
    const merge = await gitError(runGitAction(conversation, { action: "merge" }));
    expect([merge.status, merge.message]).toEqual([400, "Merging is available for tasks that run in their own worktree."]);
  });

  it("reports a workspace that is not a repository as unavailable", async () => {
    const plain = path.join(root, "plain");
    fs.mkdirSync(plain);
    vi.stubEnv("WORKSPACE_DIR", plain);
    const changes = await getChanges(conversationWith({ mode: "shared" }));
    expect(changes).toMatchObject({ available: false, reason: "The workspace is not a git repository.", files: [] });
    expect(changes.workspace).toEqual({ mode: "shared", path: plain, isGitRepo: false, branch: null, baseBranch: null, baseCommit: null });
  });
});

describe("merge and discard", () => {
  it("merges the task branch into the base branch with a merge commit", async () => {
    const { conversation, created } = await worktreeTask();
    write(created.path, "feature.txt", "feature\n");
    await runGitAction(conversation, { action: "commit", message: "Add feature" });
    const result = await runGitAction(conversation, { action: "merge" });
    expect(result.message).toBe(`Merged ${created.branch} into main.`);
    expect(read(repo, "feature.txt")).toBe("feature\n");
    expect(git(repo, "log", "-1", "--format=%s")).toBe(`Merge branch '${created.branch}'`);
    expect(git(repo, "rev-list", "--count", "--merges", "HEAD")).toBe("1");
    expect((await getChanges(conversation)).ahead).toBe(0);
  });

  it("refuses to merge into a dirty or switched main checkout", async () => {
    const { conversation, created } = await worktreeTask();
    write(created.path, "feature.txt", "feature\n");
    await runGitAction(conversation, { action: "commit", message: "Add feature" });
    write(repo, "a.txt", "local edit\n");
    const dirty = await gitError(runGitAction(conversation, { action: "merge" }));
    expect([dirty.status, dirty.message]).toEqual([409, "The main checkout has uncommitted changes. Commit or stash them, then merge again."]);
    expect(read(repo, "a.txt")).toBe("local edit\n");
    git(repo, "checkout", "-q", "--", "a.txt");
    git(repo, "checkout", "-q", "-b", "other");
    expect((await gitError(runGitAction(conversation, { action: "merge" }))).message).toContain("The main checkout is on other, not main");
  });

  it("aborts a conflicting merge and leaves the main checkout unchanged", async () => {
    const { conversation, created } = await worktreeTask();
    write(created.path, "a.txt", "ONE from the task\n");
    await runGitAction(conversation, { action: "commit", message: "Task edit" });
    write(repo, "a.txt", "ONE from main\n");
    git(repo, "commit", "-q", "-am", "Main edit");
    const before = git(repo, "rev-parse", "HEAD");

    const error = await gitError(runGitAction(conversation, { action: "merge" }));
    expect(error.status).toBe(409);
    expect(error.message).toBe(
      `Merging ${created.branch} into main conflicts in a.txt. The merge was aborted, so the main checkout is unchanged.`,
    );
    expect(git(repo, "rev-parse", "HEAD")).toBe(before);
    expect(git(repo, "status", "--porcelain")).toBe("");
    expect(read(repo, "a.txt")).toBe("ONE from main\n");
    expect(() => git(repo, "rev-parse", "-q", "--verify", "MERGE_HEAD")).toThrow();
  });

  it("discards the worktree and deletes its branch", async () => {
    const { conversation, created } = await worktreeTask();
    write(created.path, "work.txt", "work\n");
    await runGitAction(conversation, { action: "commit", message: "Work" });
    const result = await runGitAction(conversation, { action: "discard" });
    expect(result.message).toBe(`Discarded the task worktree and deleted ${created.branch}.`);
    expect(fs.existsSync(created.path)).toBe(false);
    expect(git(repo, "branch", "--list", "tatvam/*")).toBe("");
    expect(git(repo, "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
  });

  it("removes a deleted task's worktree but keeps a branch that has commits", async () => {
    const kept = await worktreeTask("Keep me");
    write(kept.created.path, "work.txt", "work\n");
    await runGitAction(kept.conversation, { action: "commit", message: "Work" });
    const empty = await worktreeTask("Nothing done");
    await removeTaskWorktree(kept.conversation);
    await removeTaskWorktree(empty.conversation);
    await removeTaskWorktree(conversationWith({ mode: "shared" }));
    expect(fs.existsSync(kept.created.path)).toBe(false);
    expect(fs.existsSync(empty.created.path)).toBe(false);
    expect(git(repo, "branch", "--list", "tatvam/*", "--format=%(refname:short)")).toBe(kept.created.branch);
  });
});

describe("remotes and pull requests", () => {
  function addGithubRemote() {
    const bare = path.join(root, "remote.git");
    git(root, "init", "-q", "--bare", "-b", "main", bare);
    git(repo, "remote", "add", "origin", "https://github.com/acme/widgets.git");
    // Pushes go to the local bare repository; the displayed remote stays on github.com.
    git(repo, "config", "remote.origin.pushurl", bare);
    return bare;
  }

  it("pushes the branch and opens a pull request with the token", async () => {
    const bare = addGithubRemote();
    vi.stubEnv("GITHUB_TOKEN", "test-token");
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () =>
      Response.json({ html_url: "https://github.com/acme/widgets/pull/7", number: 7 }, { status: 201 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { conversation, created } = await worktreeTask();
    write(created.path, "fix.txt", "fixed\n");
    await runGitAction(conversation, { action: "commit", message: "Fix" });

    const changes = await getChanges(conversation);
    expect(changes.remote).toEqual({ name: "origin", url: "https://github.com/acme/widgets.git", webUrl: "https://github.com/acme/widgets" });
    expect(changes.canOpenPullRequest).toBe(true);

    const result = await runGitAction(conversation, { action: "pull_request", title: "Fix login", body: "Details", draft: true });
    expect(result).toEqual({ message: "Opened pull request #7.", url: "https://github.com/acme/widgets/pull/7" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.github.com/repos/acme/widgets/pulls");
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer test-token");
    expect(JSON.parse(String(init?.body))).toEqual({ title: "Fix login", body: "Details", head: created.branch, base: "main", draft: true });
    expect(git(root, `--git-dir=${bare}`, "rev-parse", `refs/heads/${created.branch}`)).toBe(git(created.path, "rev-parse", "HEAD"));
  });

  it("returns the compare link when no token is set", async () => {
    addGithubRemote();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { conversation, created } = await worktreeTask();
    write(created.path, "fix.txt", "fixed\n");
    await runGitAction(conversation, { action: "commit", message: "Fix" });
    expect((await getChanges(conversation)).canOpenPullRequest).toBe(false);
    const result = await runGitAction(conversation, { action: "pull_request", title: "Fix", body: "", draft: false });
    expect(result.url).toBe(`https://github.com/acme/widgets/compare/main...${created.branch}?expand=1`);
    expect(result.message).toContain("Set GITHUB_TOKEN");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a pull request before anything is committed", async () => {
    addGithubRemote();
    const { conversation } = await worktreeTask();
    const error = await gitError(runGitAction(conversation, { action: "pull_request", title: "Fix", body: "", draft: false }));
    expect([error.status, error.message]).toEqual([409, "The task branch has no commits yet. Commit the changes first."]);
  });

  it("derives web URLs for GitHub, GitLab and Bitbucket and strips credentials", () => {
    expect(describeRemote("origin", "https://github.com/acme/widgets.git")).toEqual({
      name: "origin",
      url: "https://github.com/acme/widgets.git",
      webUrl: "https://github.com/acme/widgets",
    });
    expect(describeRemote("origin", "git@github.com:acme/widgets.git").webUrl).toBe("https://github.com/acme/widgets");
    expect(describeRemote("origin", "ssh://git@ssh.github.com:443/acme/widgets.git").webUrl).toBe("https://github.com/acme/widgets");
    expect(describeRemote("origin", "ssh://git@gitlab.com/group/sub/project.git").webUrl).toBe("https://gitlab.com/group/sub/project");
    expect(describeRemote("origin", "git@gitlab.com:group/project.git").webUrl).toBe("https://gitlab.com/group/project");
    expect(describeRemote("origin", "https://user:secret@bitbucket.org/team/repo.git")).toEqual({
      name: "origin",
      url: "https://bitbucket.org/team/repo.git",
      webUrl: "https://bitbucket.org/team/repo",
    });
    expect(describeRemote("origin", "https://x-access-token:ghp_abc@github.com/acme/widgets").url).toBe(
      "https://github.com/acme/widgets",
    );
    expect(describeRemote("origin", "ssh://git:pw@gitlab.com/g/p.git").url).toBe("ssh://git@gitlab.com/g/p.git");
    expect(describeRemote("origin", "https://example.com/acme/widgets.git").webUrl).toBeNull();
    expect(describeRemote("origin", "C:/repos/widgets.git").webUrl).toBeNull();
    expect(describeRemote("origin", "/srv/git/widgets.git").webUrl).toBeNull();
    expect(describeRemote("origin", "https://github.com/acme/widgets/extra").webUrl).toBeNull();
  });
});
