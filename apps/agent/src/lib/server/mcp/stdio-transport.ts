import "server-only";
import { spawn, type ChildProcess } from "node:child_process";
import { statSync } from "node:fs";
import path from "node:path";
import { MAX_MESSAGE_BYTES, toMessages, type JsonRpcMessage, type McpTransport } from "./jsonrpc";

// stdio transport: one child process per server, newline-delimited JSON-RPC on stdin/stdout,
// stderr kept for error messages. Spawned without a shell and with a minimal environment.

const STDERR_TAIL_CHARS = 4096;
/** How long to let stderr flush after the process exits before reporting it. */
const EXIT_REPORT_DELAY_MS = 150;

const POSIX_BASE_ENV = ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "LANG"];
const WINDOWS_BASE_ENV = [
  "PATH",
  "PATHEXT",
  "HOME",
  "USERPROFILE",
  "TEMP",
  "TMP",
  "SystemRoot",
  "windir",
  "APPDATA",
  "LOCALAPPDATA",
  "LANG",
];

/**
 * The child environment: a minimal base plus the server's configured `env`. The app's own
 * environment holds model and search API keys, so it is never passed through.
 */
export function childEnv(
  configured: Record<string, string> = {},
  source: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const windows = platform === "win32";
  const sourceKeys = Object.keys(source);
  const env: Record<string, string> = {};
  for (const name of windows ? WINDOWS_BASE_ENV : POSIX_BASE_ENV) {
    // Windows variable names are case-insensitive ("Path" vs "PATH").
    const key = windows ? sourceKeys.find((candidate) => candidate.toUpperCase() === name.toUpperCase()) : name;
    const value = key === undefined ? undefined : source[key];
    if (key !== undefined && value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(configured)) {
    if (windows)
      for (const existing of Object.keys(env)) if (existing.toUpperCase() === key.toUpperCase()) delete env[existing];
    env[key] = value;
  }
  return env;
}

function lookup(env: Record<string, string>, name: string): string | undefined {
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * Windows only: `.cmd`/`.bat` shims such as `npx` need cmd.exe, which Tatvam never uses. Mirrors
 * how spawn resolves a command (cwd, then PATH; the literal name if it has an extension, then
 * `.com` and `.exe`) and returns the batch file a shell would have run instead, if any.
 */
export function findWindowsShim(command: string, env: Record<string, string>, cwd: string): string | null {
  const win = path.win32;
  const extension = win.extname(command).toLowerCase();
  if (extension === ".cmd" || extension === ".bat") return command;
  const hasDirectory = /[\\/]/.test(command) || win.isAbsolute(command);
  const directories = hasDirectory
    ? [win.dirname(win.resolve(cwd, command))]
    : [cwd, ...(lookup(env, "PATH") ?? "").split(";").map((entry) => entry.trim().replace(/^"|"$/g, "")).filter(Boolean)];
  const name = hasDirectory ? win.basename(command) : command;
  const runnable = (directory: string) =>
    [...(extension ? [""] : []), ".com", ".exe"].some((suffix) => isFile(win.join(directory, name + suffix)));
  if (directories.some(runnable)) return null;
  const pathext = (lookup(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";").map((entry) => entry.trim().toLowerCase());
  const batch = pathext.filter((entry) => entry === ".cmd" || entry === ".bat");
  for (const directory of directories)
    for (const suffix of batch) {
      const candidate = win.join(directory, name + suffix);
      if (isFile(candidate)) return candidate;
    }
  return null;
}

export function shimMessage(command: string, shim: string): string {
  return (
    `"${command}" resolves to ${shim}, a batch script that only runs through cmd.exe, and Tatvam starts MCP servers without a shell. ` +
    `Point "command" at the real program instead: install the package (for example with npm install) and use "command": "node" ` +
    `with "args": ["<path to the package's script, e.g. node_modules/<package>/dist/index.js>"], or use the server's .exe if it has one.`
  );
}

// Children still running when the app exits are killed so they do not outlive it.
const liveChildren = new Set<ChildProcess>();
const hooks = globalThis as unknown as { tatvamMcpExitHook?: boolean };
function trackChild(child: ChildProcess) {
  liveChildren.add(child);
  if (!hooks.tatvamMcpExitHook) {
    hooks.tatvamMcpExitHook = true;
    process.once("exit", () => {
      for (const running of liveChildren) running.kill();
    });
  }
}

export type StdioOptions = { command: string; args: string[]; env: Record<string, string>; cwd?: string };

export class StdioTransport implements McpTransport {
  readonly kind = "stdio";
  onmessage?: (message: JsonRpcMessage) => void;
  onclose?: (error: Error) => void;
  private child?: ChildProcess;
  private buffer = "";
  private tail = "";
  private exited = false;
  private closing = false;
  private reported = false;
  private exitWaiters: (() => void)[] = [];

  constructor(private readonly options: StdioOptions) {}

  /** The last few KB of stderr, for error messages. */
  get stderr(): string {
    return this.tail;
  }

  start(): Promise<void> {
    const { command, args, cwd } = this.options;
    const env = childEnv(this.options.env);
    if (cwd) {
      let directory = false;
      try {
        directory = statSync(cwd).isDirectory();
      } catch {}
      if (!directory) return Promise.reject(new Error(`The working directory ${cwd} does not exist.`));
    }
    if (process.platform === "win32") {
      const shim = findWindowsShim(command, env, cwd ?? process.cwd());
      if (shim) return Promise.reject(new Error(shimMessage(command, shim)));
    }

    let child: ChildProcess;
    try {
      child = spawn(command, args, { cwd, env: env as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true });
    } catch (error) {
      return Promise.reject(new Error(`Could not start "${command}": ${(error as Error).message}`));
    }
    this.child = child;
    return new Promise<void>((resolve, reject) => {
      let spawned = false;
      child.on("error", (error: NodeJS.ErrnoException) => {
        if (spawned) return this.fail(new Error(`The server process failed: ${error.message}`));
        this.exited = true;
        this.reported = true;
        reject(
          new Error(
            error.code === "ENOENT"
              ? `Could not start "${command}": the program was not found. Use a full path or check PATH.`
              : `Could not start "${command}": ${error.message}`,
          ),
        );
      });
      child.once("spawn", () => {
        spawned = true;
        trackChild(child);
        resolve();
      });
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => this.onStdout(chunk));
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => this.remember(chunk));
      // A write after the process died surfaces as EPIPE here; the exit handler reports it.
      child.stdin?.on("error", () => {});
      child.once("exit", (code, signal) => {
        this.exited = true;
        liveChildren.delete(child);
        for (const wake of this.exitWaiters.splice(0)) wake();
        setTimeout(() => this.reportExit(code, signal), EXIT_REPORT_DELAY_MS);
      });
      child.once("close", (code, signal) => this.reportExit(code, signal));
    });
  }

  private remember(text: string) {
    this.tail = (this.tail + text).slice(-STDERR_TAIL_CHARS);
  }

  private onStdout(chunk: string) {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    if (this.buffer.length > MAX_MESSAGE_BYTES) {
      this.buffer = "";
      return this.fail(new Error("The server sent a message larger than 4 MB."));
    }
    for (const raw of lines) {
      if (this.reported) return;
      if (raw.length > MAX_MESSAGE_BYTES) return this.fail(new Error("The server sent a message larger than 4 MB."));
      const line = raw.trim();
      if (!line) continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        // Servers sometimes log to stdout; keep it for diagnostics instead of failing.
        this.remember(`[stdout] ${line.slice(0, 500)}\n`);
        continue;
      }
      for (const message of toMessages(value)) this.onmessage?.(message);
    }
  }

  private reportExit(code: number | null, signal: NodeJS.Signals | null) {
    if (this.reported) return;
    this.reported = true;
    if (this.closing) return;
    const how = code !== null ? `with code ${code}` : `on signal ${signal ?? "unknown"}`;
    const tail = this.tail.trim();
    this.onclose?.(new Error(`The server process exited ${how}${tail ? `: ${tail}` : "."}`));
  }

  private fail(error: Error) {
    if (this.reported || this.closing) return;
    this.reported = true;
    this.child?.kill();
    this.onclose?.(error);
  }

  send(message: JsonRpcMessage): Promise<void> {
    const stdin = this.child?.stdin;
    if (!stdin || this.exited || this.closing || this.reported || !stdin.writable)
      return Promise.reject(new Error("The server process is not running."));
    return new Promise((resolve, reject) => {
      stdin.write(`${JSON.stringify(message)}\n`, (error) => (error ? reject(error) : resolve()));
    });
  }

  private waitForExit(ms: number): Promise<void> {
    if (this.exited) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.exitWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /** Closes stdin, then escalates to SIGTERM and SIGKILL if the process does not exit. */
  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    const child = this.child;
    if (!child || this.exited) return;
    child.stdin?.end();
    await this.waitForExit(1000);
    if (this.exited) return;
    child.kill();
    await this.waitForExit(2000);
    if (!this.exited) child.kill("SIGKILL");
    await this.waitForExit(1000);
  }
}
