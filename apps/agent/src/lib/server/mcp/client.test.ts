// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpAbortError, McpClient, McpConnectionError, McpTimeoutError, type McpClientOptions } from "./client";
import { StdioTransport, childEnv, findWindowsShim } from "./stdio-transport";

const fixture = fileURLToPath(new URL("./fixtures/fake-server.mjs", import.meta.url));
const clients: McpClient[] = [];

function stdioClient(args: string[] = [], options: Partial<McpClientOptions> & { env?: Record<string, string> } = {}) {
  const { env = {}, ...clientOptions } = options;
  const transport = new StdioTransport({ command: process.execPath, args: [fixture, ...args], env });
  const client = new McpClient(transport, { timeoutMs: 5000, ...clientOptions });
  clients.push(client);
  return { client, transport };
}

type Received = { id?: string | number; method?: string; params?: Record<string, unknown> };
async function receivedBy(client: McpClient): Promise<Received[]> {
  const result = await client.callTool("received", {});
  return JSON.parse(String(result.content[0].text)) as Received[];
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

describe("McpClient over stdio", () => {
  it("performs the initialize handshake", async () => {
    const { client } = stdioClient();
    await client.connect();
    expect(client.protocolVersion).toBe("2025-06-18");
    expect(client.serverInfo).toEqual({ name: "fake", version: "1.0.0" });
    const received = await receivedBy(client);
    expect(received[0]).toMatchObject({
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "tatvam", version: "0.1.0" } },
    });
    expect(received[1]).toMatchObject({ method: "notifications/initialized" });
    expect(received[1].id).toBeUndefined();
  });

  it("follows tools/list pagination and skips malformed tools", async () => {
    const { client } = stdioClient(["--tools", "7", "--page-size", "3"]);
    await client.connect();
    const names = client.tools.map((tool) => tool.name);
    expect(names).toHaveLength(17);
    expect(names.slice(0, 2)).toEqual(["echo", "fail"]);
    expect(names.at(-1)).toBe("tool_6");
    const listCalls = (await receivedBy(client)).filter((message) => message.method === "tools/list");
    expect(listCalls).toHaveLength(6);
    expect(listCalls[1].params).toEqual({ cursor: "3" });
    expect(client.tools[0]).toEqual({
      name: "echo",
      title: "Echo",
      description: "Echo the text back",
      inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      annotations: { readOnlyHint: true },
    });
  });

  it("caps the tool list at 500", async () => {
    const { client } = stdioClient(["--tools", "700", "--page-size", "200"]);
    await client.connect();
    expect(client.tools).toHaveLength(500);
  });

  it("calls tools and reports isError results", async () => {
    const { client } = stdioClient();
    await client.connect();
    expect(await client.callTool("echo", { text: "hi" })).toEqual({ content: [{ type: "text", text: "hi" }], isError: false });
    expect(await client.callTool("fail", {})).toEqual({ content: [{ type: "text", text: "boom" }], isError: true });
  });

  it("cancels a call that times out", async () => {
    const { client } = stdioClient();
    await client.connect();
    const before = (await receivedBy(client)).length;
    await expect(client.callTool("slow", {}, { timeoutMs: 200 })).rejects.toBeInstanceOf(McpTimeoutError);
    const received = await receivedBy(client);
    const slow = received.slice(before).find((message) => message.method === "tools/call" && message.params?.name === "slow");
    const cancel = received.find((message) => message.method === "notifications/cancelled");
    expect(cancel?.params).toEqual({ requestId: slow?.id, reason: "Request timed out" });
  });

  it("cancels a call when the signal aborts", async () => {
    const { client } = stdioClient();
    await client.connect();
    const controller = new AbortController();
    const call = client.callTool("slow", {}, { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    await expect(call).rejects.toBeInstanceOf(McpAbortError);
    const received = await receivedBy(client);
    const slow = received.find((message) => message.params?.name === "slow");
    const cancel = received.find((message) => message.method === "notifications/cancelled");
    expect(cancel?.params).toEqual({ requestId: slow?.id, reason: "Cancelled by the user" });
  });

  it("answers ping and refuses other server requests with -32601", async () => {
    const { client } = stdioClient();
    await client.connect();
    const result = await client.callTool("ask_client", {});
    const answers = JSON.parse(String(result.content[0].text));
    expect(answers.ping).toMatchObject({ result: {} });
    expect(answers.other).toMatchObject({ error: { code: -32601 } });
  });

  it("refreshes the tool list on notifications/tools/list_changed", async () => {
    const onToolsChanged = vi.fn();
    const { client } = stdioClient([], { onToolsChanged });
    await client.connect();
    expect(client.tools.some((tool) => tool.name === "added")).toBe(false);
    await client.callTool("change_tools", {});
    await vi.waitFor(() => expect(client.tools.some((tool) => tool.name === "added")).toBe(true));
    expect(onToolsChanged).toHaveBeenCalled();
  });

  it("rejects pending calls and reports the exit with stderr when the process dies", async () => {
    const onClose = vi.fn();
    const { client } = stdioClient([], { onClose });
    await client.connect();
    const error = await client.callTool("exit", {}).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(McpConnectionError);
    expect((error as Error).message).toMatch(/exited with code 3: fatal: going away/);
    expect(onClose).toHaveBeenCalledTimes(1);
    await expect(client.callTool("echo", { text: "x" })).rejects.toBeInstanceOf(McpConnectionError);
  });

  it("explains a server that crashes during startup", async () => {
    const { client } = stdioClient(["--crash"]);
    await expect(client.connect()).rejects.toThrow(/exited with code 2: fatal: cannot start/);
  });

  it("explains a command that does not exist", async () => {
    const transport = new StdioTransport({ command: "tatvam-no-such-program-xyz", args: [], env: {} });
    const client = new McpClient(transport, { timeoutMs: 5000 });
    clients.push(client);
    await expect(client.connect()).rejects.toThrow(/not found/);
  });

  it("refuses unsupported protocol versions", async () => {
    const { client } = stdioClient(["--protocol", "1999-01-01"]);
    await expect(client.connect()).rejects.toThrow(/1999-01-01/);
  });

  it("does not pass the app's secrets to the child process", async () => {
    vi.stubEnv("GPU_API_KEY", "sk-should-not-leak");
    vi.stubEnv("TAVILY_API_KEY", "tv-should-not-leak");
    const { client } = stdioClient([], { env: { FAKE_TOKEN: "configured" } });
    await client.connect();
    const result = await client.callTool("env", {});
    const seen = JSON.parse(String(result.content[0].text)) as { GPU_API_KEY: string | null; FAKE_TOKEN: string; keys: string[] };
    expect(seen.GPU_API_KEY).toBeNull();
    expect(seen.FAKE_TOKEN).toBe("configured");
    expect(seen.keys).not.toContain("TAVILY_API_KEY");
    const allowed = new Set(["PATH", "PATHEXT", "HOME", "USERPROFILE", "TEMP", "TMP", "TMPDIR", "SYSTEMROOT", "WINDIR", "APPDATA", "LOCALAPPDATA", "LANG", "FAKE_TOKEN"]);
    // Node or the OS may add a few process-level variables of their own on startup.
    const unexpected = seen.keys.filter((key) => !allowed.has(key.toUpperCase()) && /KEY|TOKEN|SECRET/i.test(key));
    expect(unexpected).toEqual([]);
  });
});

describe("childEnv", () => {
  it("keeps only the base variables plus the configured env", () => {
    const env = childEnv({ EXTRA: "1" }, { PATH: "/bin", HOME: "/home/me", GPU_API_KEY: "x", OPENAI_API_KEY: "y" }, "linux");
    expect(env).toEqual({ PATH: "/bin", HOME: "/home/me", EXTRA: "1" });
  });

  it("matches Windows names case-insensitively and lets configured values win", () => {
    const env = childEnv({ PATH: "C:\\tools" }, { Path: "C:\\Windows", SystemRoot: "C:\\Windows", BRAVE_API_KEY: "x" }, "win32");
    expect(env).toEqual({ SystemRoot: "C:\\Windows", PATH: "C:\\tools" });
  });
});

describe.runIf(process.platform === "win32")("Windows batch shims", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("detects .cmd shims through PATH and refuses to start them", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "tatvam-shim-"));
    writeFileSync(path.join(dir, "fakeshim.cmd"), "@echo off\r\n");
    expect(findWindowsShim("fakeshim", { PATH: dir }, os.tmpdir())).toBe(path.join(dir, "fakeshim.cmd"));
    expect(findWindowsShim(process.execPath, { PATH: dir }, os.tmpdir())).toBeNull();
    const transport = new StdioTransport({ command: "fakeshim", args: [], env: { PATH: dir } });
    await expect(transport.start()).rejects.toThrow(/fakeshim\.cmd.*"command": "node"/);
  });
});
