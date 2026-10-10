// Fake MCP server for tests: newline-delimited JSON-RPC 2.0 over stdio.
// Options: --tools N (extra numbered tools), --page-size N, --init-delay MS, --crash, --protocol V.
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : fallback;
};

if (argv.includes("--crash")) {
  process.stderr.write("fatal: cannot start\n", () => process.exit(2));
} else {
  serve();
}

function serve() {
  const extraTools = Number(option("tools", "0"));
  const pageSize = Number(option("page-size", "100"));
  const initDelay = Number(option("init-delay", "0"));
  const protocolVersion = option("protocol", "2025-06-18");

  const received = [];
  const waiting = new Map();
  let nextId = 1;
  let added = false;

  const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
  const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
  const text = (value) => ({ content: [{ type: "text", text: value }] });
  const object = { type: "object" };
  const never = () => new Promise(() => {});
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function ask(method, params) {
    const id = `server-${nextId++}`;
    send({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve) => waiting.set(id, resolve));
  }

  function tools() {
    const list = [
      {
        name: "echo",
        title: "Echo",
        description: "Echo the text back",
        inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
        annotations: { readOnlyHint: true },
      },
      { name: "fail", description: "Always fails", inputSchema: object },
      { name: "slow", description: "Never answers", inputSchema: object, annotations: { openWorldHint: true } },
      { name: "received", description: "Messages received so far", inputSchema: object },
      { name: "env", description: "Report the environment", inputSchema: object },
      { name: "exit", description: "Exit the process", inputSchema: object },
      { name: "mixed", description: "Mixed content", inputSchema: object },
      { name: "structured", description: "Structured content only", inputSchema: { properties: { x: { type: "number" } } } },
      { name: "change_tools", description: "Add a tool and announce it", inputSchema: object },
      { name: "ask_client", description: "Send requests to the client", inputSchema: object },
      { name: 42, description: "Malformed: skipped by the client" },
    ];
    if (added) list.push({ name: "added", description: "Added later", inputSchema: object });
    for (let index = 0; index < extraTools; index++) list.push({ name: `tool_${index}`, inputSchema: object });
    return list;
  }

  async function callTool(name, args) {
    switch (name) {
      case "echo":
        return text(String(args.text ?? ""));
      case "fail":
        return { content: [{ type: "text", text: "boom" }], isError: true };
      case "slow":
        return never();
      case "received":
        return text(JSON.stringify(received));
      case "env":
        return text(
          JSON.stringify({
            GPU_API_KEY: process.env.GPU_API_KEY ?? null,
            FAKE_TOKEN: process.env.FAKE_TOKEN ?? null,
            keys: Object.keys(process.env),
          }),
        );
      case "exit":
        process.stderr.write("fatal: going away\n", () => process.exit(3));
        return never();
      case "mixed":
        return {
          content: [
            { type: "text", text: "hello" },
            { type: "image", data: Buffer.alloc(10).toString("base64"), mimeType: "image/png" },
            { type: "resource", resource: { uri: "file:///a.txt", text: "inside" } },
            { type: "resource", resource: { uri: "file:///b.bin", blob: "AAAA" } },
            { type: "resource_link", uri: "file:///c.txt", name: "c" },
          ],
        };
      case "structured":
        return { content: [], structuredContent: { answer: 42 } };
      case "change_tools":
        added = true;
        send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
        return text("changed");
      case "ask_client": {
        const ping = await ask("ping");
        const other = await ask("sampling/createMessage", { messages: [] });
        return text(JSON.stringify({ ping, other }));
      }
      default:
        return { content: [{ type: "text", text: `unknown tool ${name}` }], isError: true };
    }
  }

  async function handle(message) {
    received.push({ id: message.id, method: message.method, params: message.params });
    if (message.method === undefined) {
      const resolve = waiting.get(message.id);
      waiting.delete(message.id);
      resolve?.(message);
      return;
    }
    if (message.id === undefined) return;
    const { id, method, params = {} } = message;
    if (method === "initialize") {
      if (initDelay) await sleep(initDelay);
      return reply(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: "fake", version: "1.0.0" },
      });
    }
    if (method === "tools/list") {
      const all = tools();
      const start = Number(params.cursor ?? 0);
      const end = start + pageSize;
      return reply(id, { tools: all.slice(start, end), ...(end < all.length ? { nextCursor: String(end) } : {}) });
    }
    if (method === "tools/call") return reply(id, await callTool(params.name, params.arguments ?? {}));
    if (method === "ping") return reply(id, {});
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
  }

  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    if (!line.trim()) return;
    void handle(JSON.parse(line));
  });
  lines.on("close", () => process.exit(0));
}
