import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { commandConfig } from "../config";
import { MAX_TOOL_OUTPUT_CHARS, truncate, type ToolDefinition, type ToolOutput } from "./types";
import { ensureWorkspace } from "./workspace-path";

const MAX_CAPTURE_BYTES = 1024 * 1024;
const MAX_TIMEOUT_SECONDS = 3600;
/** How long to wait for output pipes to close after the process exits (a background grandchild may hold them). */
const CLOSE_GRACE_MS = 2000;

const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|COOKIE/i;
const UTF8_PREAMBLE = "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ";
const SCRUBBED_NAMES =new Set(["OLLAMA_BASE_URL", "GPU_BASE_URL", "SEARXNG_URL"]);

type CommandConfig = ReturnType<typeof commandConfig>;

/**
 * `docker run` arguments for one sandboxed command: no network unless enabled, all capabilities
 * dropped, no privilege escalation, read-only root filesystem with a writable /tmp, memory, CPU and
 * process limits, and only the workspace mounted. The workspace's `.git` entry, when present, is
 * mounted read-only so sandboxed commands cannot change repository metadata that host-side git
 * operations later read. The command goes to `sh -c` inside the container as a single argument,
 * never through a host shell.
 */
export function dockerArgs(
  config: Pick<CommandConfig, "image" | "network" | "user" | "memoryMb" | "cpus">,
  name: string,
  workspace: string,
  command: string,
  options: { hasGitEntry?: boolean } = {},
): string[] {
  return [
    "run",
    "--rm",
    "-i",
    "--name",
    name,
    ...(config.network ? [] : ["--network", "none"]),
    "--memory",
    `${config.memoryMb}m`,
    "--cpus",
    String(config.cpus),
    "--pids-limit",
    "512",
    "--security-opt",
    "no-new-privileges",
    "--cap-drop",
    "ALL",
    "--read-only",
    "--tmpfs",
    "/tmp:rw,exec,size=512m",
    "-e",
    "HOME=/tmp",
    ...(config.user ? ["--user", config.user] : []),
    "-v",
    `${workspace}:/workspace`,
    ...(options.hasGitEntry ? ["-v", `${path.join(workspace, ".git")}:/workspace/.git:ro`] : []),
    "-w",
    "/workspace",
    config.image,
    "sh",
    "-c",
    command,
  ];
}

/** Executable and arguments for running a command directly on the host. */
export function hostInvocation(command: string, platform: NodeJS.Platform = process.platform) {
  return platform === "win32"
    ? // Windows PowerShell 5.1 pipes output in the legacy code page; switch to UTF-8 so non-ASCII text survives.
      { file: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", `${UTF8_PREAMBLE}${command}`] }
    : { file: "/bin/bash", args: ["-lc", command] };
}

/**
 * Copy of the environment without anything that looks like a credential or an internal service
 * address. Defence in depth only: host commands still run with the server user's full rights.
 */
export function scrubEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean = { ...env };
  for (const key of Object.keys(clean)) {
    if (SECRET_NAME.test(key) || SCRUBBED_NAMES.has(key.toUpperCase())) delete clean[key];
  }
  return clean;
}

/** Keeps the first and last half of the captured bytes once output passes the cap. */
class OutputCollector {
  private head: Buffer[] = [];
  private headBytes = 0;
  private tail: Buffer[] = [];
  private tailBytes = 0;
  private dropped = 0;
  private readonly half = MAX_CAPTURE_BYTES / 2;

  push(chunk: Buffer): void {
    if (this.headBytes < this.half) {
      const take = Math.min(chunk.length, this.half - this.headBytes);
      this.head.push(chunk.subarray(0, take));
      this.headBytes += take;
      chunk = chunk.subarray(take);
    }
    if (chunk.length === 0) return;
    this.tail.push(chunk);
    this.tailBytes += chunk.length;
    while (this.tailBytes > this.half) {
      const excess = this.tailBytes - this.half;
      const first = this.tail[0];
      if (first.length <= excess) {
        this.tail.shift();
        this.tailBytes -= first.length;
        this.dropped += first.length;
      } else {
        this.tail[0] = first.subarray(excess);
        this.tailBytes -= excess;
        this.dropped += excess;
      }
    }
  }

  text(): string {
    if (this.dropped === 0) return Buffer.concat([...this.head, ...this.tail]).toString("utf8");
    const head = Buffer.concat(this.head).toString("utf8");
    const tail = Buffer.concat(this.tail).toString("utf8");
    return `${head}\n[... ${this.dropped} bytes of output omitted ...]\n${tail}`;
  }
}

type ProcessSpec = { file: string; args: string[]; options: SpawnOptions; kill: (child: ChildProcess) => void };
type ProcessResult = {
  output: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  cancelled: boolean;
  spawnError?: NodeJS.ErrnoException;
};

function runProcess(spec: ProcessSpec, timeoutMs: number, abort: AbortSignal): Promise<ProcessResult> {
  let child: ChildProcess;
  try {
    child = spawn(spec.file, spec.args, spec.options);
  } catch (error) {
    // Synchronous failures, for example an argument containing a NUL byte.
    const spawnError = error as NodeJS.ErrnoException;
    return Promise.resolve({ output: "", exitCode: null, signal: null, timedOut: false, cancelled: false, spawnError });
  }
  return new Promise((resolve) => {
    const collector = new OutputCollector();
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    let grace: NodeJS.Timeout | undefined;

    const timer = setTimeout(() => {
      timedOut = true;
      spec.kill(child);
    }, timeoutMs);
    const onAbort = () => {
      cancelled = true;
      spec.kill(child);
    };
    const finish = (exitCode: number | null, signal: NodeJS.Signals | null, spawnError?: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      abort.removeEventListener("abort", onAbort);
      resolve({ output: collector.text(), exitCode, signal, timedOut, cancelled, spawnError });
    };
    abort.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (chunk: Buffer) => collector.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => collector.push(chunk));
    child.stdin?.on("error", () => {}); // The process may exit before stdin is closed.
    child.stdin?.end();
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (child.pid === undefined) finish(null, null, error); // Never started, for example ENOENT.
    });
    child.on("exit", (code, signal) => {
      grace = setTimeout(() => finish(code, signal), CLOSE_GRACE_MS);
    });
    child.on("close", (code, signal) => finish(code, signal));
  });
}

function killHost(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    // taskkill /T takes the whole tree; child.kill() would leave grandchildren running.
    spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () =>
      child.kill(),
    );
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL"); // The child leads its own process group (detached).
  } catch {
    child.kill("SIGKILL");
  }
}

/** Keeps the start and the end of long output: errors and test summaries usually come last. */
function headAndTail(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.3);
  const tail = max - head;
  return `${text.slice(0, head)}\n\n[... ${text.length - max} characters omitted ...]\n\n${text.slice(-tail)}`;
}

function formatResult(command: string, result: ProcessResult, timeoutSeconds: number, docker: boolean): ToolOutput {
  if (result.spawnError) {
    if (result.spawnError.code === "ENOENT") {
      return {
        status: "error",
        content: docker
          ? "Docker was not found. Install Docker or set DOCKER_PATH."
          : `Could not start the shell: ${result.spawnError.message}`,
      };
    }
    return { status: "error", content: `Could not start the command: ${result.spawnError.message}` };
  }
  let status: string;
  if (result.timedOut) status = `[timed out after ${timeoutSeconds}s]`;
  else if (result.cancelled) status = "[cancelled]";
  else if (result.exitCode === null) status = `[killed by ${result.signal ?? "signal"}]`;
  else status = `[exit code ${result.exitCode}]`;

  const budget = Math.max(1000, MAX_TOOL_OUTPUT_CHARS - command.length - 200);
  const output = headAndTail(result.output.replace(/\r\n/g, "\n").trimEnd(), budget) || "(no output)";
  return {
    // A nonzero exit is still a successful tool call: the model needs to read the failure.
    status: result.timedOut || result.cancelled ? "error" : "ok",
    content: truncate(`$ ${command}\n${output}\n${status}`),
  };
}

const schema = z
  .object({
    command: z.string().min(1).max(8000).describe("Shell command to run in the workspace directory."),
    timeout_seconds: z
      .number()
      .int()
      .min(1)
      .max(MAX_TIMEOUT_SECONDS)
      .optional()
      .describe("Kill the command after this many seconds. Defaults to the server setting."),
  })
  .strict();

export const runCommandTool: ToolDefinition<typeof schema> = {
  name: "run_command",
  title: "Run command",
  description:
    "Run a shell command in the workspace directory and return its combined stdout and stderr with the exit code. " +
    "Use it to run tests, builds, linters, git and other CLI tools. Commands run non-interactively with no stdin, " +
    "so pass flags that avoid prompts (for example --yes). Long-running servers or watchers will be killed at the " +
    "timeout. Depending on configuration, commands run in a Docker sandbox (Linux sh, usually without network) " +
    "or on the host (PowerShell on Windows, bash elsewhere).",
  schema,
  defaultPolicy: "ask",
  risk: "execute",
  available: () =>
    commandConfig().runner === "off"
      ? { ok: false, reason: "Set COMMAND_RUNNER=docker (recommended) or host" }
      : { ok: true },
  summarize: (input) => {
    const oneLine = input.command.replace(/\s+/g, " ").trim();
    return `Run \`${oneLine.length > 80 ? `${oneLine.slice(0, 80)}...` : oneLine}\``;
  },
  async run(input, ctx) {
    const config = commandConfig();
    // Fail closed if the runner was switched off after the tool was offered.
    if (config.runner === "off") return { status: "error", content: "Commands are disabled (COMMAND_RUNNER is off)" };
    if (ctx.signal.aborted) return { status: "error", content: "Cancelled before the command started" };

    const timeoutSeconds = Math.min(input.timeout_seconds ?? config.timeoutSeconds, MAX_TIMEOUT_SECONDS);
    let workspace: string;
    try {
      workspace = await ensureWorkspace();
    } catch (error) {
      return { status: "error", content: `Workspace is unavailable: ${error instanceof Error ? error.message : String(error)}` };
    }

    let spec: ProcessSpec;
    if (config.runner === "docker") {
      const name = `tatvam-${randomUUID()}`;
      spec = {
        file: config.dockerPath,
        args: dockerArgs(config, name, workspace, input.command, {
          hasGitEntry: existsSync(path.join(workspace, ".git")),
        }),
        options: { shell: false, stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
        kill: (child) => {
          // Killing the docker client does not stop the container, so kill it by name as well.
          spawn(config.dockerPath, ["kill", name], { stdio: "ignore", windowsHide: true }).on("error", () => {});
          child.kill("SIGKILL");
        },
      };
    } else {
      const { file, args } = hostInvocation(input.command);
      spec = {
        file,
        args,
        options: {
          cwd: workspace,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
          env: scrubEnv(process.env),
          detached: process.platform !== "win32",
          windowsHide: true,
        },
        kill: killHost,
      };
    }

    const result = await runProcess(spec, timeoutSeconds * 1000, ctx.signal);
    return formatResult(input.command, result, timeoutSeconds, config.runner === "docker");
  },
};
