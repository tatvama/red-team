// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dockerArgs, hostInvocation, runCommandTool, scrubEnv } from "./command";

const ctx = { signal: new AbortController().signal, conversationId: "test" };
const isWindows = process.platform === "win32";
const config = { image: "node:24-bookworm", network: false, user: undefined, memoryMb: 2048, cpus: 2 };

let workspace: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tatvam-cmd-"));
  vi.stubEnv("WORKSPACE_DIR", workspace);
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

describe("dockerArgs", () => {
  it("isolates the container and mounts only the workspace", () => {
    const args = dockerArgs(config, "tatvam-abc", "/srv/ws", "npm test");
    const joined = args.join(" ");
    expect(args.slice(0, 5)).toEqual(["run", "--rm", "-i", "--name", "tatvam-abc"]);
    expect(joined).toContain("--network none");
    expect(joined).toContain("--cap-drop ALL");
    expect(joined).toContain("--security-opt no-new-privileges");
    expect(joined).toContain("--read-only");
    expect(joined).toContain("--pids-limit 512");
    expect(joined).toContain("--memory 2048m --cpus 2");
    expect(joined).toContain("--tmpfs /tmp:rw,exec,size=512m -e HOME=/tmp");
    expect(joined).toContain("-v /srv/ws:/workspace -w /workspace");
    expect(args).not.toContain("--user");
    expect(args.slice(-4)).toEqual(["node:24-bookworm", "sh", "-c", "npm test"]);
  });

  it("omits the network flag when networking is enabled and adds the user when set", () => {
    const args = dockerArgs({ ...config, network: true, user: "1000:1000" }, "n", "/ws", "ls");
    expect(args).not.toContain("--network");
    expect(args.join(" ")).toContain("--user 1000:1000");
  });

  it("mounts the repository metadata read-only when the workspace has a .git entry", () => {
    const joined = dockerArgs(config, "n", "/ws", "ls", { hasGitEntry: true }).join(" ");
    expect(joined).toMatch(/-v \/ws:\/workspace -v [\\/]ws[\\/]\.git:\/workspace\/\.git:ro -w \/workspace/);
    expect(dockerArgs(config, "n", "/ws", "ls").join(" ")).not.toContain(".git");
  });

  it("passes the command as one argument so the host never parses it", () => {
    const command = 'echo "a b" && rm -rf / ; $(whoami)';
    expect(dockerArgs(config, "n", "/ws", command).at(-1)).toBe(command);
  });
});

describe("hostInvocation and scrubEnv", () => {
  it("uses PowerShell on Windows and bash elsewhere", () => {
    expect(hostInvocation("dir", "win32")).toEqual({
      file: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-Command", "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; dir"],
    });
    expect(hostInvocation("ls", "linux")).toEqual({ file: "/bin/bash", args: ["-lc", "ls"] });
  });

  it("drops secrets and internal service URLs", () => {
    const env = scrubEnv({
      NODE_ENV: "test",
      PATH: "/usr/bin",
      HOME: "/home/u",
      BRAVE_API_KEY: "x",
      GITHUB_TOKEN: "x",
      db_password: "x",
      AWS_SECRET_ACCESS_KEY: "x",
      GOOGLE_APPLICATION_CREDENTIALS: "x",
      SESSION_COOKIE: "x",
      OLLAMA_BASE_URL: "x",
      gpu_base_url: "x",
      SEARXNG_URL: "x",
    });
    expect(env).toEqual({ NODE_ENV: "test", PATH: "/usr/bin", HOME: "/home/u" });
  });
});

describe("run_command availability", () => {
  it("is unavailable and refuses to run while the runner is off", async () => {
    vi.stubEnv("COMMAND_RUNNER", "");
    expect(runCommandTool.available()).toEqual({ ok: false, reason: "Set COMMAND_RUNNER=docker (recommended) or host" });
    const result = await runCommandTool.run({ command: "echo hi" }, ctx);
    expect(result.status).toBe("error");
  });

  it("reports a missing Docker binary clearly", async () => {
    vi.stubEnv("COMMAND_RUNNER", "docker");
    vi.stubEnv("DOCKER_PATH", "tatvam-no-such-docker-binary");
    expect(runCommandTool.available()).toEqual({ ok: true });
    const result = await runCommandTool.run({ command: "echo hi" }, ctx);
    expect(result).toEqual({ status: "error", content: "Docker was not found. Install Docker or set DOCKER_PATH." });
  });

  it("summarizes long commands on one line", () => {
    expect(runCommandTool.summarize({ command: "npm test" })).toBe("Run `npm test`");
    expect(runCommandTool.summarize({ command: `echo ${"x".repeat(200)}` })).toBe(`Run \`echo ${"x".repeat(75)}...\``);
  });
});

describe("run_command on the host", () => {
  beforeEach(() => {
    vi.stubEnv("COMMAND_RUNNER", "host");
  });

  it("runs a command in the workspace and reports the exit code", async () => {
    await fs.writeFile(path.join(workspace, "marker.txt"), "");
    const command = isWindows ? "echo hello; Get-ChildItem -Name" : "echo hello; ls";
    const result = await runCommandTool.run({ command }, ctx);
    expect(result).toEqual({ status: "ok", content: `$ ${command}\nhello\nmarker.txt\n[exit code 0]` });
  }, 30_000);

  it("returns nonzero exits as ok so the model can read the failure", async () => {
    const result = await runCommandTool.run({ command: "echo failing; exit 3" }, ctx);
    expect(result).toEqual({ status: "ok", content: "$ echo failing; exit 3\nfailing\n[exit code 3]" });
  }, 30_000);

  it("does not pass secrets to the command", async () => {
    vi.stubEnv("TATVAM_TEST_API_KEY", "super-secret-value");
    vi.stubEnv("TATVAM_TEST_VISIBLE", "visible-value");
    const command = isWindows
      ? "echo \"[$env:TATVAM_TEST_API_KEY]\"; echo $env:TATVAM_TEST_VISIBLE"
      : 'echo "[$TATVAM_TEST_API_KEY]"; echo "$TATVAM_TEST_VISIBLE"';
    const result = await runCommandTool.run({ command }, ctx);
    expect(result.content).toContain("[]\nvisible-value");
    expect(result.content).not.toContain("super-secret-value");
  }, 30_000);

  it("kills commands that exceed the timeout", async () => {
    const command = isWindows ? "Start-Sleep -Seconds 5" : "sleep 5";
    const started = Date.now();
    const result = await runCommandTool.run({ command, timeout_seconds: 1 }, ctx);
    expect(result.status).toBe("error");
    expect(result.content).toContain("[timed out after 1s]");
    expect(Date.now() - started).toBeLessThan(5000);
  }, 30_000);

  it("stops when the conversation is cancelled", async () => {
    const controller = new AbortController();
    const command = isWindows ? "Start-Sleep -Seconds 5" : "sleep 5";
    setTimeout(() => controller.abort(), 300);
    const result = await runCommandTool.run({ command }, { signal: controller.signal, conversationId: "test" });
    expect(result.status).toBe("error");
    expect(result.content).toContain("[cancelled]");
  }, 30_000);
});
