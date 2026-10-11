// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpClient, McpTimeoutError } from "./client";
import { startFakeHttpServer, type FakeHttpServer } from "./fixtures/fake-http-server";
import { HttpTransport, SseParser, checkServerUrl } from "./http-transport";

let server: FakeHttpServer | undefined;
const clients: McpClient[] = [];

async function connect(mode: "json" | "sse", headers: Record<string, string> = {}) {
  server = await startFakeHttpServer({ mode });
  const client = new McpClient(new HttpTransport(server.url, headers), { timeoutMs: 5000 });
  clients.push(client);
  await client.connect();
  return { client, server };
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await server?.close();
  server = undefined;
});

describe.each(["json", "sse"] as const)("Streamable HTTP (%s responses)", (mode) => {
  it("initializes, keeps the session id and sends the protocol version header", async () => {
    const { client, server } = await connect(mode, { Authorization: "Bearer test-token" });
    expect(client.tools.map((tool) => tool.name)).toEqual(["echo", "fail", "slow", "big"]);
    const posts = server.received.filter((entry) => entry.method !== "GET");
    expect(posts[0]).toMatchObject({ method: "initialize", sessionId: undefined, protocolVersion: undefined });
    expect(posts[0].accept).toBe("application/json, text/event-stream");
    const session = posts[1].sessionId;
    expect(session).toBeTruthy();
    expect(posts.slice(1).every((entry) => entry.sessionId === session && entry.protocolVersion === "2025-06-18")).toBe(true);
    expect(posts.every((entry) => entry.authorization === "Bearer test-token")).toBe(true);
    expect(posts.map((entry) => entry.method)).toEqual(["initialize", "notifications/initialized", "tools/list"]);
  });

  it("calls tools and reports isError results", async () => {
    const { client } = await connect(mode);
    expect(await client.callTool("echo", { text: "hi" })).toEqual({ content: [{ type: "text", text: "hi" }], isError: false });
    expect((await client.callTool("fail", {})).isError).toBe(true);
  });

  it("sends notifications/cancelled when a call times out", async () => {
    const { client, server } = await connect(mode);
    await expect(client.callTool("slow", {}, { timeoutMs: 200 })).rejects.toBeInstanceOf(McpTimeoutError);
    const slow = server.received.find((entry) => entry.message?.method === "tools/call")?.message;
    await vi.waitFor(() => {
      const cancel = server.received.find((entry) => entry.method === "notifications/cancelled");
      expect(cancel?.message?.params).toEqual({ requestId: slow?.id, reason: "Request timed out" });
    });
  });

  it("refuses responses larger than 4 MB", async () => {
    const { client } = await connect(mode);
    await expect(client.callTool("big", {})).rejects.toThrow(/larger than 4 MB/);
  });

  it("ends the session with DELETE on close", async () => {
    const { client, server } = await connect(mode);
    const session = server.received[1].sessionId;
    await client.close();
    expect(server.deleted).toEqual([session]);
  });
});

describe("Streamable HTTP extras", () => {
  it("refreshes tools when list_changed arrives on the GET stream", async () => {
    const onToolsChanged = vi.fn();
    server = await startFakeHttpServer({ mode: "sse" });
    const client = new McpClient(new HttpTransport(server.url), { timeoutMs: 5000, onToolsChanged });
    clients.push(client);
    await client.connect();
    const fake = server;
    await vi.waitFor(() => expect(fake.openStreams()).toBe(1));
    fake.announceToolChange();
    await vi.waitFor(() => expect(client.tools.map((tool) => tool.name)).toContain("added"));
    expect(onToolsChanged).toHaveBeenCalled();
  });

  it("does not follow redirects", async () => {
    server = await startFakeHttpServer({ mode: "json", redirect: true });
    const client = new McpClient(new HttpTransport(server.url), { timeoutMs: 5000 });
    clients.push(client);
    await expect(client.connect()).rejects.toThrow(/redirect \(HTTP 307\)/);
    expect(server.received).toHaveLength(1);
  });

  it("refuses plain http:// to a non-loopback host without making a request", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const client = new McpClient(new HttpTransport("http://example.com/mcp"), { timeoutMs: 5000 });
    await expect(client.connect()).rejects.toThrow(/must use https/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reports an unreachable server", async () => {
    const client = new McpClient(new HttpTransport("http://127.0.0.1:9/mcp"), { timeoutMs: 5000 });
    await expect(client.connect()).rejects.toThrow(/Could not reach the MCP server/);
  });
});

describe("checkServerUrl", () => {
  it.each(["https://example.com/mcp", "http://localhost:3001/mcp", "http://127.0.0.1/mcp", "http://[::1]:8080/mcp"])("allows %s", (url) => {
    expect(() => checkServerUrl(url)).not.toThrow();
  });

  it.each([
    ["http://example.com/mcp", /https/],
    ["http://10.0.0.5/mcp", /https/],
    ["ftp://example.com/mcp", /https/],
    ["https://user:pw@example.com/mcp", /credentials/],
    ["nope", /valid URL/],
  ])("refuses %s", (url, message) => {
    expect(() => checkServerUrl(url)).toThrow(message);
  });
});

describe("SseParser", () => {
  it("handles split chunks, CRLF, comments, multi-line data and ids", () => {
    const parser = new SseParser();
    expect(parser.feed(": hi\r\nevent: message\r\ndata: {\"a\":")).toEqual([]);
    expect(parser.feed("1}\r")).toEqual([]);
    expect(parser.feed("\ndata: more\r\nid: 7\r\n\r\n")).toEqual([{ event: "message", data: '{"a":1}\nmore', id: "7" }]);
    expect(parser.lastEventId).toBe("7");
    expect(parser.feed("retry: 2500\n\n")).toEqual([]);
    expect(parser.retryMs).toBe(2500);
  });

  it("refuses oversized events", () => {
    const parser = new SseParser(10);
    expect(() => parser.feed(`data: ${"x".repeat(20)}\n`)).toThrow(/larger than 4 MB/);
  });
});
