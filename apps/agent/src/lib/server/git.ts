import "server-only";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  DefaultWorkspaceView,
  GitAction,
  GitActionResult,
  GitChanges,
  Isolation,
  WorkspaceInfo,
} from "@/lib/contract";
import { dataDir, defaultWorkspaceDir, githubToken } from "./config";
import type { ConversationRow } from "./db";
import { DiffBudget, addedFile, formatAddedFile, isBinary, parseUnifiedDiff } from "./diff";

// Git review for tasks: worktree per task, diffs against the task's starting commit, and the
// commit / push / pull request / merge / discard actions. Git always runs as `git <args>` with an
// argument array and no shell. Hooks are disabled, because a hook script in the working tree can be
// written by the agent and would otherwise run on the host when the user presses a button.

/** A failure whose message is safe to show the user. */
export class GitError extends Error {
  override name = "GitError";
  constructor(
    message: string,
    /** HTTP status for routes: 400 for requests that cannot work, 409 for the current repository state. */
    readonly status: 400 | 409 | 500 = 409,
  ) {
    super(message);
  }
}

const TIMEOUT_MS = 30_000;
const PUSH_TIMEOUT_MS = 120_000;
const MAX_STDOUT_BYTES = 8 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
/** Untracked files larger than this are shown from their first bytes only. */
const MAX_UNTRACKED_READ = 2 * 1024 * 1024;
/** The git_diff tool output is cut to 20,000 characters later; stop building well past that. */
const MAX_TOOL_DIFF_CHARS = 40_000;

const SHA = /^[0-9a-f]{7,64}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TASK_BRANCH = /^tatvam\/[a-z0-9][a-z0-9-]*$/;
const SAFE_BRANCH = /^(?!-)[^\s~^:?*[\\\x00-\x1f\x7f]+$/;

/** Variables that would point git at another repository, index or object store than the one asked for. */
const REPOSITORY_ENV = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
  "GIT_PREFIX",
];

export function isConversationId(id: string): boolean {
  return UUID.test(id);
}

// ── Per-conversation lock ────────────────────────────────────────────────────

const lockStore = globalThis as unknown as { tatvamGitLocks?: Map<string, Promise<unknown>> };
const locks = (lockStore.tatvamGitLocks ??= new Map<string, Promise<unknown>>());

/** Runs `work` after every earlier call with the same key has settled (git actions, snapshots, restores). */
export function withConversationLock<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const next = previous.then(work, work);
  const tail = next.then(
    () => undefined,
    () => undefined,
  );
  locks.set(key, tail);
  void tail.then(() => {
    if (locks.get(key) === tail) locks.delete(key);
  });
  return next;
}

// ── Running git ──────────────────────────────────────────────────────────────

export type GitRun = { code: number; stdout: string; stderr: string; truncated: boolean };
export type GitRunOptions = {
  cwd: string;
  timeoutMs?: number;
  maxBytes?: number;
  /** Options placed before the subcommand, for example `--git-dir=...`. */
  globalArgs?: string[];
};

async function isDirectory(dir: string): Promise<boolean> {
  return (await fs.stat(dir).catch(() => null))?.isDirectory() ?? false;
}

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    // Git Credential Manager would otherwise open a sign-in window on the server.
    GCM_INTERACTIVE: "never",
    // Read-only commands must not take the index lock the user's own git may need.
    GIT_OPTIONAL_LOCKS: "0",
    GIT_MERGE_AUTOEDIT: "no",
  };
  for (const name of REPOSITORY_ENV) delete env[name];
  return env;
}

function configArgs(): string[] {
  return [
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.quotePath=false",
    // Never created, so no hook can run.
    "-c",
    `core.hooksPath=${path.join(dataDir(), "git-hooks-disabled")}`,
    ...(process.platform === "win32" ? ["-c", "core.longpaths=true"] : []),
  ];
}

/** Runs git and returns its exit code and capped output. Throws GitError only when git cannot run. */
export async function runGit(args: string[], options: GitRunOptions): Promise<GitRun> {
  if (!(await isDirectory(options.cwd))) throw new GitError(`The folder ${options.cwd} does not exist.`, 409);
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? MAX_STDOUT_BYTES;
  return new Promise<GitRun>((resolve, reject) => {
    const child = spawn("git", [...configArgs(), ...(options.globalArgs ?? []), ...args], {
      cwd: options.cwd,
      env: gitEnv(),
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      if (truncated) return;
      const room = maxBytes - outBytes;
      if (chunk.length > room) {
        stdout.push(chunk.subarray(0, room));
        outBytes = maxBytes;
        truncated = true;
        child.kill();
        return;
      }
      stdout.push(chunk);
      outBytes += chunk.length;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (errBytes >= MAX_STDERR_BYTES) return;
      stderr.push(chunk);
      errBytes += chunk.length;
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      reject(
        error.code === "ENOENT"
          ? new GitError("Git is not installed, or it is not on the server's PATH.", 500)
          : new GitError(`Git could not start: ${error.message}`, 500),
      );
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (timedOut) {
        reject(new GitError(`Git took longer than ${Math.round(timeoutMs / 1000)} seconds and was stopped.`, 500));
        return;
      }
      resolve({
        // A capped read stops git on purpose; what was read is still a valid result.
        code: truncated ? 0 : (code ?? 1),
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        truncated,
      });
    });
  });
}

const CREDENTIALS_IN_URL = /([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi;

/** Removes `user:token@` from any URL in `text`. */
export function redactUrlCredentials(text: string): string {
  return text.replace(CREDENTIALS_IN_URL, "$1");
}

/** The useful part of git's stderr: its error lines, without hints or credentials. */
function describeFailure(stderr: string): string {
  const lines = redactUrlCredentials(stderr)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("hint:"));
  const errors = lines.filter((line) => /^(fatal|error):/i.test(line));
  const text = (errors.length > 0 ? errors : lines)
    .slice(0, 3)
    .map((line) => line.replace(/^(fatal|error):\s*/i, ""))
    .join(" ");
  if (!text) return "git reported an error.";
  return text.length > 400 ? `${text.slice(0, 397)}...` : text;
}

async function gitOk(args: string[], options: GitRunOptions, failure: string, status: 400 | 409 = 409): Promise<string> {
  const result = await runGit(args, options);
  if (result.code !== 0) throw new GitError(`${failure}: ${describeFailure(result.stderr)}`, status);
  return result.stdout;
}

// ── Repository facts ─────────────────────────────────────────────────────────

type RepoContext = { toplevel: string; commonDir: string; prefix: string };

/**
 * The repository `dir` belongs to, or null. A folder that the enclosing repository ignores (for
 * example a workspace inside the app's own data folder) does not count as part of that repository.
 */
async function repoContext(dir: string): Promise<RepoContext | null> {
  if (!(await isDirectory(dir))) return null;
  const result = await runGit(
    ["rev-parse", "--is-inside-work-tree", "--show-toplevel", "--git-common-dir", "--show-prefix"],
    { cwd: dir },
  );
  if (result.code !== 0) return null;
  const [inside, toplevel, commonDir, prefix = ""] = result.stdout.split(/\r?\n/);
  if (inside !== "true" || !toplevel || !commonDir) return null;
  if (prefix && (await runGit(["check-ignore", "-q", "."], { cwd: dir })).code === 0) return null;
  return { toplevel: path.resolve(toplevel), commonDir: path.resolve(dir, commonDir), prefix };
}

async function revParse(dir: string, rev: string): Promise<string | null> {
  const result = await runGit(["rev-parse", "--verify", "--quiet", rev], { cwd: dir });
  return result.code === 0 ? result.stdout.trim() || null : null;
}

async function currentBranch(dir: string): Promise<string | null> {
  const result = await runGit(["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: dir });
  return result.code === 0 ? result.stdout.trim() || null : null;
}

const headCommit = (dir: string) => revParse(dir, "HEAD^{commit}");

async function commitExists(dir: string, rev: string): Promise<boolean> {
  return SHA.test(rev) && (await runGit(["cat-file", "-e", `${rev}^{commit}`], { cwd: dir })).code === 0;
}

/** Uncommitted changes under `dir`. `tracked` ignores untracked files (they never block a merge). */
async function hasUncommittedChanges(dir: string, scope: "all" | "tracked" = "all"): Promise<boolean> {
  const untracked = scope === "all" ? "--untracked-files=normal" : "--untracked-files=no";
  const result = await runGit(["status", "--porcelain", "-z", untracked, "--", "."], { cwd: dir });
  return result.code === 0 && result.stdout.length > 0;
}

async function requireIdentity(dir: string): Promise<void> {
  const checks = await Promise.all(
    ["GIT_AUTHOR_IDENT", "GIT_COMMITTER_IDENT"].map((name) => runGit(["var", name], { cwd: dir })),
  );
  if (checks.some((check) => check.code !== 0)) {
    throw new GitError(
      'Git has no user identity on the server. Run git config --global user.name "Your Name" and ' +
        "git config --global user.email you@example.com, then try again.",
      409,
    );
  }
}

export async function inspectWorkspace(dir: string): Promise<DefaultWorkspaceView> {
  try {
    if (!(await repoContext(dir))) return { path: dir, isGitRepo: false, branch: null };
    return { path: dir, isGitRepo: true, branch: await currentBranch(dir) };
  } catch {
    return { path: dir, isGitRepo: false, branch: null };
  }
}

export async function sharedBaseline(dir: string): Promise<{ branch: string | null; baseCommit: string } | null> {
  try {
    if (!(await repoContext(dir))) return null;
    const baseCommit = await headCommit(dir);
    return baseCommit ? { branch: await currentBranch(dir), baseCommit } : null;
  } catch {
    return null;
  }
}

// ── Task worktrees ───────────────────────────────────────────────────────────

/** Branch-safe slug: lowercase ASCII letters, digits and dashes, at most 40 characters. */
export function branchSlug(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return slug || "task";
}

function worktreeRoot(conversationId: string): string {
  return path.join(dataDir(), "worktrees", conversationId);
}

async function mainRepository(): Promise<RepoContext> {
  const context = await repoContext(defaultWorkspaceDir());
  if (!context) {
    throw new GitError("The workspace is no longer a git repository, so the task worktree cannot be checked.", 409);
  }
  return context;
}

async function samePath(a: string, b: string): Promise<boolean> {
  const [left, right] = await Promise.all([fs.realpath(a).catch(() => null), fs.realpath(b).catch(() => null)]);
  if (!left || !right) return false;
  const normal = (value: string) => {
    const resolved = path.normalize(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normal(left) === normal(right);
}

const BROKEN_LINK =
  "The task worktree's .git entry does not point into the workspace repository, so git commands were not run.";

/**
 * A linked worktree's `.git` is a file containing `gitdir: <main>/.git/worktrees/<name>`, and that
 * folder's `gitdir` file points back. Anything else (a `.git` folder, a link elsewhere) could carry
 * its own config, so git is not run there.
 */
async function verifyWorktree(root: string, main: RepoContext): Promise<void> {
  const link = path.join(root, ".git");
  const stat = await fs.lstat(link).catch(() => null);
  if (!stat?.isFile() || stat.size > 4096) throw new GitError(BROKEN_LINK, 409);
  const match = /^gitdir: (.+)$/.exec((await fs.readFile(link, "utf8")).split(/\r?\n/)[0]);
  if (!match) throw new GitError(BROKEN_LINK, 409);
  const gitdir = path.resolve(root, match[1].trim());
  const worktrees = path.dirname(gitdir);
  if (path.basename(worktrees).toLowerCase() !== "worktrees" || !(await samePath(path.dirname(worktrees), main.commonDir))) {
    throw new GitError(BROKEN_LINK, 409);
  }
  const back = await fs.readFile(path.join(gitdir, "gitdir"), "utf8").catch(() => null);
  if (!back || !(await samePath(path.resolve(gitdir, back.trim()), link))) throw new GitError(BROKEN_LINK, 409);
}

/** The nearest folder at or above `start` that has a `.git` entry. */
async function findWorktreeRoot(start: string): Promise<string> {
  let current = path.resolve(start);
  for (;;) {
    if (await fs.lstat(path.join(current, ".git")).catch(() => null)) return current;
    const parent = path.dirname(current);
    if (parent === current) throw new GitError(BROKEN_LINK, 409);
    current = parent;
  }
}

export async function createTaskWorktree(
  conversationId: string,
  title: string,
): Promise<{ path: string; branch: string; baseBranch: string | null; baseCommit: string }> {
  if (!isConversationId(conversationId)) throw new GitError("Invalid task id.", 400);
  const source = defaultWorkspaceDir();
  const context = await repoContext(source);
  if (!context) throw new GitError("The workspace is not a git repository, so the task cannot have its own worktree.", 400);
  const baseCommit = await headCommit(source);
  if (!baseCommit) {
    throw new GitError("The workspace repository has no commits yet. Make a first commit, then start the task again.", 409);
  }
  const baseBranch = await currentBranch(source);
  const branch = `tatvam/${branchSlug(title)}-${conversationId.slice(0, 6).toLowerCase()}`;
  const root = worktreeRoot(conversationId);
  if (await fs.lstat(root).catch(() => null)) throw new GitError("A worktree for this task already exists.", 409);
  await fs.mkdir(path.dirname(root), { recursive: true });
  await gitOk(["worktree", "add", "-b", branch, root, baseCommit], { cwd: context.toplevel }, "Could not create the task worktree");
  await verifyWorktree(root, context);
  // A workspace below the repository root keeps the same relative folder inside the worktree.
  const workspace = context.prefix ? path.join(root, ...context.prefix.split("/").filter(Boolean)) : root;
  await fs.mkdir(workspace, { recursive: true });
  return { path: workspace, branch, baseBranch, baseCommit };
}

type ResolvedWorkspace = { dir: string; mode: Isolation; main: RepoContext | null };

/** The folder git runs in for this conversation, after checking a task worktree's link. */
async function resolveWorkspace(conversation: ConversationRow): Promise<ResolvedWorkspace> {
  if (conversation.workspaceMode !== "worktree") {
    return { dir: conversation.workspacePath ?? defaultWorkspaceDir(), mode: "shared", main: null };
  }
  const dir = conversation.workspacePath;
  if (!dir) throw new GitError("This task has no worktree.", 409);
  if (!(await isDirectory(dir))) throw new GitError("The task's worktree folder no longer exists.", 409);
  const main = await mainRepository();
  await verifyWorktree(await findWorktreeRoot(dir), main);
  return { dir, mode: "worktree", main };
}

export function workspaceInfo(conversation: ConversationRow): WorkspaceInfo {
  return {
    mode: conversation.workspaceMode,
    path: conversation.workspacePath ?? defaultWorkspaceDir(),
    isGitRepo: conversation.baseCommit !== null,
    branch: conversation.branch,
    baseBranch: conversation.baseBranch,
    baseCommit: conversation.baseCommit,
  };
}

function taskBranches(conversation: ConversationRow): { branch: string; baseBranch: string | null } {
  const branch = conversation.branch;
  if (!branch || !TASK_BRANCH.test(branch)) throw new GitError("This task has no Tatvam branch.", 400);
  const baseBranch = conversation.baseBranch && SAFE_BRANCH.test(conversation.baseBranch) ? conversation.baseBranch : null;
  return { branch, baseBranch };
}

export async function removeTaskWorktree(conversation: ConversationRow): Promise<void> {
  if (conversation.workspaceMode !== "worktree" || !conversation.workspacePath) return;
  try {
    const main = await mainRepository();
    if (await isDirectory(conversation.workspacePath)) {
      const root = await findWorktreeRoot(conversation.workspacePath);
      await verifyWorktree(root, main);
      await runGit(["worktree", "remove", "--force", root], { cwd: main.toplevel });
    }
    await runGit(["worktree", "prune"], { cwd: main.toplevel });
    // Keep a branch that has commits, so deleting a task never loses committed work.
    const branch = conversation.branch;
    if (branch && TASK_BRANCH.test(branch) && conversation.baseCommit && SHA.test(conversation.baseCommit)) {
      const ahead = await runGit(["rev-list", "--count", `${conversation.baseCommit}..refs/heads/${branch}`], {
        cwd: main.toplevel,
      });
      if (ahead.code === 0 && ahead.stdout.trim() === "0") await runGit(["branch", "-D", branch], { cwd: main.toplevel });
    }
  } catch {
    // Best effort: a leftover worktree can be removed with `git worktree prune`.
  }
}

// ── Remotes ──────────────────────────────────────────────────────────────────

const WEB_HOSTS: Record<string, string> = {
  "github.com": "github.com",
  "www.github.com": "github.com",
  "ssh.github.com": "github.com",
  "gitlab.com": "gitlab.com",
  "www.gitlab.com": "gitlab.com",
  "altssh.gitlab.com": "gitlab.com",
  "bitbucket.org": "bitbucket.org",
  "www.bitbucket.org": "bitbucket.org",
  "altssh.bitbucket.org": "bitbucket.org",
};
const PATH_SEGMENT = /^[A-Za-z0-9_.-]+$/;

/** Host and repository path of a GitHub, GitLab or Bitbucket remote (https or ssh), else null. */
function remoteLocation(url: string): { host: string; segments: string[] } | null {
  let host: string;
  let pathname: string;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    if (!["https:", "http:", "ssh:", "git+ssh:", "ssh+git:", "git:"].includes(parsed.protocol)) return null;
    host = parsed.hostname.toLowerCase();
    pathname = parsed.pathname;
  } else {
    // scp-like `git@github.com:owner/repo.git`. One-letter hosts are Windows drive letters.
    const scp = /^(?:[^@\s/]+@)?([^:\s/]{2,}):(?!\/\/)(.+)$/.exec(url);
    if (!scp) return null;
    host = scp[1].toLowerCase();
    pathname = scp[2];
  }
  const canonical = WEB_HOSTS[host];
  if (!canonical) return null;
  const segments = pathname
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.git$/i, "")
    .split("/")
    .filter(Boolean);
  if (segments.length < 2 || !segments.every((part) => PATH_SEGMENT.test(part) && part !== "." && part !== "..")) return null;
  if (canonical !== "gitlab.com" && segments.length !== 2) return null;
  return { host: canonical, segments };
}

/** Remote URL for display: credentials removed from http(s) URLs, passwords from any URL. */
export function stripUrlCredentials(url: string): string {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return url;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return redactUrlCredentials(url);
  }
}

export function describeRemote(name: string, url: string): { name: string; url: string; webUrl: string | null } {
  const location = remoteLocation(url);
  return {
    name,
    url: stripUrlCredentials(url),
    webUrl: location ? `https://${location.host}/${location.segments.join("/")}` : null,
  };
}

function githubRepo(url: string): { owner: string; repo: string } | null {
  const location = remoteLocation(url);
  return location?.host === "github.com" ? { owner: location.segments[0], repo: location.segments[1] } : null;
}

async function readRemote(dir: string): Promise<{ name: string; url: string; webUrl: string | null; raw: string } | null> {
  const result = await runGit(["remote", "get-url", "origin"], { cwd: dir });
  const raw = result.stdout.trim();
  if (result.code !== 0 || !raw) return null;
  return { ...describeRemote("origin", raw), raw };
}

// ── Changes ──────────────────────────────────────────────────────────────────

const DIFF_ARGS = ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "-M", "--relative", "--src-prefix=a/", "--dst-prefix=b/"];

async function trackedDiff(dir: string, base: string, pathspec: string[] = [], maxBytes?: number): Promise<{ text: string; truncated: boolean }> {
  const result = await runGit([...DIFF_ARGS, base, "--", ...pathspec], { cwd: dir, maxBytes });
  if (result.code !== 0) throw new GitError(`Could not compute the changes: ${describeFailure(result.stderr)}`, 409);
  return { text: result.stdout, truncated: result.truncated };
}

/** Untracked files that are not ignored, relative to `dir`. Embedded repositories (`sub/`) are skipped. */
async function untrackedPaths(dir: string, pathspec: string[] = []): Promise<string[]> {
  const result = await runGit(["ls-files", "--others", "--exclude-standard", "-z", "--", ...pathspec], { cwd: dir });
  if (result.code !== 0) return [];
  return result.stdout
    .split("\0")
    .filter((entry) => entry && !entry.endsWith("/"))
    .sort();
}

async function countLines(file: string): Promise<number> {
  let count = 0;
  let last = 10;
  for await (const chunk of createReadStream(file)) {
    const buffer = chunk as Buffer;
    for (let at = buffer.indexOf(10); at !== -1; at = buffer.indexOf(10, at + 1)) count++;
    if (buffer.length > 0) last = buffer[buffer.length - 1];
  }
  return last === 10 ? count : count + 1;
}

/** Reads an untracked file without following links out of the workspace (a link shows its target, as in git). */
async function readUntracked(
  dir: string,
  relative: string,
): Promise<{ content: Buffer; partial?: boolean; totalLines?: number } | null> {
  const absolute = path.join(dir, ...relative.split("/"));
  const stat = await fs.lstat(absolute).catch(() => null);
  if (!stat) return null;
  if (stat.isSymbolicLink()) {
    const target = await fs.readlink(absolute).catch(() => null);
    return target === null ? null : { content: Buffer.from(target, "utf8") };
  }
  if (!stat.isFile()) return null;
  if (stat.size <= MAX_UNTRACKED_READ) {
    const content = await fs.readFile(absolute).catch(() => null);
    return content ? { content } : null;
  }
  const handle = await fs.open(absolute, "r").catch(() => null);
  if (!handle) return null;
  try {
    const buffer = Buffer.alloc(MAX_UNTRACKED_READ);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const content = buffer.subarray(0, bytesRead);
    return { content, partial: true, totalLines: isBinary(content) ? 0 : await countLines(absolute) };
  } finally {
    await handle.close();
  }
}

/** Commits on the task branch that its base branch (or, failing that, the starting commit) lacks. */
async function countAhead(dir: string, conversation: ConversationRow): Promise<number> {
  const worktree = conversation.workspaceMode === "worktree";
  const tip = worktree && conversation.branch && TASK_BRANCH.test(conversation.branch) ? `refs/heads/${conversation.branch}` : "HEAD";
  const bases = [
    worktree && conversation.baseBranch && SAFE_BRANCH.test(conversation.baseBranch) ? `refs/heads/${conversation.baseBranch}` : null,
    conversation.baseCommit && SHA.test(conversation.baseCommit) ? conversation.baseCommit : null,
  ];
  for (const base of bases) {
    if (!base) continue;
    const result = await runGit(["rev-list", "--count", `${base}..${tip}`], { cwd: dir });
    if (result.code === 0) return Number.parseInt(result.stdout.trim(), 10) || 0;
  }
  return 0;
}

export async function getChanges(conversation: ConversationRow): Promise<GitChanges> {
  const workspace = workspaceInfo(conversation);
  const unavailable = (reason: string): GitChanges => ({
    available: false,
    reason,
    workspace,
    files: [],
    additions: 0,
    deletions: 0,
    truncated: false,
    ahead: 0,
    hasUncommitted: false,
    remote: null,
    canOpenPullRequest: false,
  });
  try {
    const base = conversation.baseCommit;
    if (!base || !SHA.test(base)) {
      // Only shared folders are probed: git never runs in a worktree before its link is checked.
      const repository = conversation.workspaceMode === "shared" ? await repoContext(workspace.path).catch(() => null) : null;
      return unavailable(
        repository
          ? "This task started before the workspace was a git repository, so there is no starting point to compare with."
          : "The workspace is not a git repository.",
      );
    }
    const { dir } = await resolveWorkspace(conversation);
    if (!(await repoContext(dir))) return unavailable("The workspace is not a git repository.");
    if (!(await commitExists(dir, base))) return unavailable("The commit this task started from is no longer in the repository.");

    const [diff, untracked, hasUncommitted, ahead, remote] = await Promise.all([
      trackedDiff(dir, base),
      untrackedPaths(dir),
      hasUncommittedChanges(dir),
      countAhead(dir, conversation),
      readRemote(dir),
    ]);
    const budget = new DiffBudget();
    const files = parseUnifiedDiff(diff.text, budget);
    if (diff.truncated) {
      budget.truncated = true;
      const last = files.at(-1);
      if (last) last.truncated = true;
    }
    for (const relative of untracked) {
      if (budget.files >= budget.limits.maxFiles) {
        budget.truncated = true;
        break;
      }
      const read = await readUntracked(dir, relative);
      if (!read) continue;
      const file = addedFile(relative, read.content, budget, read);
      if (file) files.push(file);
    }
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return {
      available: true,
      workspace,
      files,
      additions: files.reduce((sum, file) => sum + file.additions, 0),
      deletions: files.reduce((sum, file) => sum + file.deletions, 0),
      truncated: budget.truncated,
      ahead,
      hasUncommitted,
      remote: remote ? { name: remote.name, url: remote.url, webUrl: remote.webUrl } : null,
      canOpenPullRequest: Boolean(githubToken()) && remote !== null && githubRepo(remote.raw) !== null,
    };
  } catch (error) {
    if (error instanceof GitError) return unavailable(error.message);
    throw error;
  }
}

/**
 * Unified diff text of the workspace against the task's starting commit (or HEAD), including
 * untracked files, for the git_diff tool. `pathspec` is a workspace-relative path that was already
 * checked to stay inside the workspace.
 */
export async function workspaceDiff(
  conversation: ConversationRow | null,
  dir: string,
  pathspec: string | null,
): Promise<{ base: string | null; againstTaskStart: boolean; text: string }> {
  if (conversation?.workspaceMode === "worktree") {
    await verifyWorktree(await findWorktreeRoot(dir), await mainRepository());
  }
  if (!(await repoContext(dir))) {
    throw new GitError("The workspace is not a git repository, so there are no changes to show.", 400);
  }
  const taskBase = conversation?.baseCommit ?? null;
  const againstTaskStart = taskBase !== null && (await commitExists(dir, taskBase));
  const base = againstTaskStart ? taskBase : await headCommit(dir);
  const spec = pathspec && pathspec !== "." ? [`:(literal)${pathspec}`] : [];
  const [tracked, untracked] = await Promise.all([
    base ? trackedDiff(dir, base, spec, 1024 * 1024) : Promise.resolve({ text: "", truncated: false }),
    untrackedPaths(dir, spec),
  ]);
  let text = tracked.text;
  for (const relative of untracked) {
    if (text.length > MAX_TOOL_DIFF_CHARS) break;
    const read = await readUntracked(dir, relative);
    if (read) text += formatAddedFile(relative, read.content);
  }
  return { base, againstTaskStart, text };
}

// ── Actions ──────────────────────────────────────────────────────────────────

async function pushBranch(dir: string, branch: string): Promise<void> {
  const result = await runGit(["push", "-u", "origin", branch], { cwd: dir, timeoutMs: PUSH_TIMEOUT_MS });
  if (result.code === 0) return;
  if (/\[rejected\]|non-fast-forward|fetch first/i.test(result.stderr)) {
    throw new GitError(`Push was rejected because origin has commits that ${branch} does not. Pull or rebase first, then push again.`, 409);
  }
  throw new GitError(`Push failed: ${describeFailure(result.stderr)}`, 409);
}

async function commit(dir: string, message: string): Promise<GitActionResult> {
  await requireIdentity(dir);
  // `-- .` keeps both steps to the workspace folder when it is below the repository root.
  await gitOk(["add", "-A", "--", "."], { cwd: dir }, "Could not stage the changes");
  const staged = await runGit(["diff", "--cached", "--quiet", "--", "."], { cwd: dir });
  if (staged.code === 0) throw new GitError("There are no changes to commit.", 409);
  await gitOk(["commit", "--quiet", `--message=${message}`, "--", "."], { cwd: dir }, "Commit failed");
  const sha = (await gitOk(["rev-parse", "--short", "HEAD"], { cwd: dir }, "Commit failed")).trim();
  return { message: `Committed ${sha}: ${message.split("\n")[0]}` };
}

async function push(dir: string): Promise<GitActionResult> {
  const branch = await currentBranch(dir);
  if (!branch || !SAFE_BRANCH.test(branch)) throw new GitError("The workspace is not on a branch, so there is nothing to push.", 409);
  if (!(await readRemote(dir))) throw new GitError("The repository has no remote named origin.", 400);
  await pushBranch(dir, branch);
  return { message: `Pushed ${branch} to origin.` };
}

function githubErrorDetail(data: unknown): string {
  if (!data || typeof data !== "object") return "";
  const record = data as { message?: unknown; errors?: unknown };
  const parts = [typeof record.message === "string" ? record.message : ""];
  if (Array.isArray(record.errors)) {
    for (const item of record.errors) {
      if (item && typeof item === "object" && typeof (item as { message?: unknown }).message === "string") {
        parts.push((item as { message: string }).message);
      }
    }
  }
  const text = parts.filter(Boolean).join(" ");
  return text.length > 300 ? `${text.slice(0, 297)}...` : text;
}

const encodeRef = (name: string) => name.split("/").map(encodeURIComponent).join("/");

async function pullRequest(
  conversation: ConversationRow,
  workspace: ResolvedWorkspace,
  action: Extract<GitAction, { action: "pull_request" }>,
): Promise<GitActionResult> {
  if (workspace.mode !== "worktree") throw new GitError("Pull requests are available for tasks that run in their own worktree.", 400);
  const { branch, baseBranch } = taskBranches(conversation);
  if (!baseBranch) throw new GitError("This task has no base branch to open a pull request against.", 400);
  const remote = await readRemote(workspace.dir);
  const repo = remote ? githubRepo(remote.raw) : null;
  if (!repo) throw new GitError("Pull requests need an origin remote on github.com.", 400);
  if ((await countAhead(workspace.dir, conversation)) === 0) {
    throw new GitError("The task branch has no commits yet. Commit the changes first.", 409);
  }
  const [local, pushed] = await Promise.all([
    revParse(workspace.dir, `refs/heads/${branch}`),
    revParse(workspace.dir, `refs/remotes/origin/${branch}`),
  ]);
  if (!local || local !== pushed) await pushBranch(workspace.dir, branch);
  const note = (await hasUncommittedChanges(workspace.dir)) ? " Uncommitted changes are not included." : "";

  const token = githubToken();
  if (!token) {
    return {
      message: `Pushed ${branch}. Set GITHUB_TOKEN on the server to open pull requests from Tatvam, or open one on GitHub with this link.${note}`,
      url: `https://github.com/${repo.owner}/${repo.repo}/compare/${encodeRef(baseBranch)}...${encodeRef(branch)}?expand=1`,
    };
  }
  const api = `https://api.github.com/repos/${repo.owner}/${repo.repo}/pulls`;
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "User-Agent": "tatvam",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  let response: Response;
  try {
    response = await fetch(api, {
      method: "POST",
      headers,
      body: JSON.stringify({ title: action.title, body: action.body, head: branch, base: baseBranch, draft: action.draft }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new GitError(`Pushed ${branch}, but GitHub could not be reached to open the pull request.`, 409);
  }
  const data = (await response.json().catch(() => null)) as { html_url?: unknown; number?: unknown } | null;
  if (response.status === 201 && typeof data?.html_url === "string" && data.html_url.startsWith("https://")) {
    return { message: `Opened pull request #${String(data.number ?? "")}.${note}`, url: data.html_url };
  }
  if (response.status === 422) {
    const query = new URLSearchParams({ head: `${repo.owner}:${branch}`, state: "open" });
    const existing = await fetch(`${api}?${query}`, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) })
      .then((reply) => (reply.ok ? reply.json() : null))
      .catch(() => null);
    const url = Array.isArray(existing) ? (existing[0] as { html_url?: unknown } | undefined)?.html_url : undefined;
    if (typeof url === "string" && url.startsWith("https://")) {
      return { message: "A pull request for this branch is already open.", url };
    }
  }
  if (response.status === 401) throw new GitError("GitHub rejected GITHUB_TOKEN. Check that the token is valid.", 400);
  const detail = githubErrorDetail(data);
  throw new GitError(`GitHub did not open the pull request (status ${response.status})${detail ? `: ${detail}` : "."}`, 409);
}

async function merge(conversation: ConversationRow, workspace: ResolvedWorkspace): Promise<GitActionResult> {
  if (workspace.mode !== "worktree" || !workspace.main) {
    throw new GitError("Merging is available for tasks that run in their own worktree.", 400);
  }
  const { branch, baseBranch } = taskBranches(conversation);
  if (!baseBranch) throw new GitError("This task has no base branch to merge into.", 400);
  const main = workspace.main.toplevel;
  if (await hasUncommittedChanges(workspace.dir)) {
    throw new GitError("The task has uncommitted changes. Commit or discard them before merging.", 409);
  }
  if ((await countAhead(workspace.dir, conversation)) === 0) {
    throw new GitError(`Nothing to merge: ${branch} has no commits that ${baseBranch} does not already have.`, 409);
  }
  const mainBranch = await currentBranch(main);
  if (mainBranch !== baseBranch) {
    throw new GitError(
      `The main checkout is on ${mainBranch ?? "a detached HEAD"}, not ${baseBranch}. Switch it to ${baseBranch}, then merge again.`,
      409,
    );
  }
  if (await hasUncommittedChanges(main, "tracked")) {
    throw new GitError("The main checkout has uncommitted changes. Commit or stash them, then merge again.", 409);
  }
  await requireIdentity(main);
  const result = await runGit(["merge", "--no-ff", "--no-edit", branch], { cwd: main });
  if (result.code === 0) return { message: `Merged ${branch} into ${baseBranch}.` };

  const conflicts = await runGit(["diff", "--name-only", "--diff-filter=U", "-z"], { cwd: main });
  const files = conflicts.stdout.split("\0").filter(Boolean);
  const merging = (await revParse(main, "MERGE_HEAD")) !== null;
  if (merging) await runGit(["merge", "--abort"], { cwd: main });
  if (files.length > 0) {
    const shown = files.slice(0, 10).join(", ") + (files.length > 10 ? ` and ${files.length - 10} more` : "");
    throw new GitError(
      `Merging ${branch} into ${baseBranch} conflicts in ${shown}. The merge was aborted, so the main checkout is unchanged.`,
      409,
    );
  }
  throw new GitError(`Merge failed: ${describeFailure(result.stderr)}${merging ? " The merge was aborted." : ""}`, 409);
}

async function discard(conversation: ConversationRow): Promise<GitActionResult> {
  if (conversation.workspaceMode !== "worktree" || !conversation.workspacePath) {
    throw new GitError("Only tasks that run in their own worktree can be discarded.", 400);
  }
  const { branch } = taskBranches(conversation);
  const main = await mainRepository();
  if (await isDirectory(conversation.workspacePath)) {
    const root = await findWorktreeRoot(conversation.workspacePath);
    await verifyWorktree(root, main);
    await gitOk(["worktree", "remove", "--force", root], { cwd: main.toplevel }, "Could not remove the task worktree");
  }
  await runGit(["worktree", "prune"], { cwd: main.toplevel });
  if (await revParse(main.toplevel, `refs/heads/${branch}`)) {
    await gitOk(["branch", "-D", branch], { cwd: main.toplevel }, "The worktree was removed, but its branch could not be deleted");
  }
  return { message: `Discarded the task worktree and deleted ${branch}.` };
}

export async function runGitAction(conversation: ConversationRow, action: GitAction): Promise<GitActionResult> {
  return withConversationLock(conversation.id, async () => {
    if (action.action === "discard") return discard(conversation);
    const workspace = await resolveWorkspace(conversation);
    if (!(await repoContext(workspace.dir))) throw new GitError("The workspace is not a git repository.", 400);
    switch (action.action) {
      case "commit":
        return commit(workspace.dir, action.message);
      case "push":
        return push(workspace.dir);
      case "pull_request":
        return pullRequest(conversation, workspace, action);
      case "merge":
        return merge(conversation, workspace);
    }
  });
}
