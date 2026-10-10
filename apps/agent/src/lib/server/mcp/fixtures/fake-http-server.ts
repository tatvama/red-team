import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

// Fake Streamable HTTP MCP server for tests. "json" mode answers with application/json; "sse" mode
// answers with text/event-stream (a log notification first, then the response) and offers a GET stream.

type Message = { jsonrpc?: string; id?: string | number; method?: string; params?: Record<string, unknown> };

export type ReceivedRequest = {
  method: string;
  message: Message | null;
  sessionId: string | undefined;
  protocolVersion: string | undefined;
  accept: string | undefined;
  authorization: string | undefined;
};

export type FakeHttpServer = {
  url: string;
  received: ReceivedRequest[];
  /** Session ids ended with DELETE. */
  deleted: string[];
  /** Pushes notifications/tools/list_changed on open GET streams and adds a tool. */
  announceToolChange(): void;
  openStreams(): number;
  close(): Promise<void>;
};

const header = (request: IncomingMessage, name: string) => {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
};

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => (body += chunk));
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

export async function startFakeHttpServer(options: { mode: "json" | "sse"; redirect?: boolean }): Promise<FakeHttpServer> {
  const received: ReceivedRequest[] = [];
  const deleted: string[] = [];
  const sessions = new Set<string>();
  const streams = new Set<ServerResponse>();
  let added = false;

  const tools = () => [
    { name: "echo", description: "Echo", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
    { name: "fail", description: "Fails", inputSchema: { type: "object" } },
    { name: "slow", description: "Never answers", inputSchema: { type: "object" } },
    { name: "big", description: "Answers with 5 MB", inputSchema: { type: "object" } },
    ...(added ? [{ name: "added", description: "Added later", inputSchema: { type: "object" } }] : []),
  ];

  function announceToolChange() {
    added = true;
    for (const stream of streams)
      stream.write(`data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })}\n\n`);
  }

  async function result(message: Message): Promise<unknown> {
    const params = message.params ?? {};
    switch (message.method) {
      case "initialize":
        return { protocolVersion: "2025-06-18", capabilities: { tools: { listChanged: true } }, serverInfo: { name: "fake-http" } };
      case "tools/list":
        return { tools: tools() };
      case "ping":
        return {};
      case "tools/call": {
        const args = (params.arguments ?? {}) as Record<string, unknown>;
        if (params.name === "echo") return { content: [{ type: "text", text: String(args.text ?? "") }] };
        if (params.name === "fail") return { content: [{ type: "text", text: "boom" }], isError: true };
        if (params.name === "slow") return new Promise(() => {});
        if (params.name === "big") return { content: [{ type: "text", text: "x".repeat(5 * 1024 * 1024) }] };
        return { content: [{ type: "text", text: "unknown" }], isError: true };
      }
      default:
        throw new Error("Method not found");
    }
  }

  async function handlePost(request: IncomingMessage, response: ServerResponse, entry: ReceivedRequest) {
    if (options.redirect) {
      response.writeHead(307, { Location: "https://elsewhere.example/mcp" }).end();
      return;
    }
    const accept = entry.accept ?? "";
    if (!accept.includes("application/json") || !accept.includes("text/event-stream")) {
      response.writeHead(406).end();
      return;
    }
    let message: Message;
    try {
      message = JSON.parse(await readBody(request)) as Message;
    } catch {
      response.writeHead(400).end();
      return;
    }
    entry.message = message;
    entry.method = message.method ?? "(response)";
    const extra: Record<string, string> = {};
    if (message.method === "initialize") {
      const id = randomUUID();
      sessions.add(id);
      extra["Mcp-Session-Id"] = id;
    } else if (!entry.sessionId) {
      response.writeHead(400).end("missing session");
      return;
    } else if (!sessions.has(entry.sessionId)) {
      response.writeHead(404).end("unknown session");
      return;
    }
    if (message.id === undefined || message.method === undefined) {
      response.writeHead(202).end();
      return;
    }
    let body: Record<string, unknown>;
    try {
      body = { jsonrpc: "2.0", id: message.id, result: await result(message) };
    } catch (error) {
      body = { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: (error as Error).message } };
    }
    if (response.destroyed) return;
    if (options.mode === "json") {
      response.writeHead(200, { "Content-Type": "application/json", ...extra }).end(JSON.stringify(body));
      return;
    }
    response.writeHead(200, { "Content-Type": "text/event-stream", ...extra });
    const log = { jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: "working" } };
    response.write(`: comment\n\nevent: message\ndata: ${JSON.stringify(log)}\n\n`);
    response.end(`id: ${randomUUID()}\ndata: ${JSON.stringify(body)}\n\n`);
  }

  const server = createServer((request, response) => {
    const entry: ReceivedRequest = {
      method: request.method ?? "",
      message: null,
      sessionId: header(request, "mcp-session-id"),
      protocolVersion: header(request, "mcp-protocol-version"),
      accept: header(request, "accept"),
      authorization: header(request, "authorization"),
    };
    received.push(entry);
    if (request.method === "POST") {
      void handlePost(request, response, entry);
    } else if (request.method === "GET") {
      entry.method = "GET";
      if (options.mode === "json" || !entry.sessionId || !sessions.has(entry.sessionId)) {
        response.writeHead(405).end();
        return;
      }
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write(": stream open\n\n");
      streams.add(response);
      response.on("close", () => streams.delete(response));
    } else if (request.method === "DELETE") {
      entry.method = "DELETE";
      if (entry.sessionId) {
        deleted.push(entry.sessionId);
        sessions.delete(entry.sessionId);
      }
      response.writeHead(200).end();
    } else {
      response.writeHead(405).end();
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    received,
    deleted,
    announceToolChange,
    openStreams: () => streams.size,
    close: async () => {
      for (const stream of streams) stream.end();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
