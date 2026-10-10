import "server-only";
import { z } from "zod";
import {
  JsonRpcError,
  METHOD_NOT_FOUND,
  isNotification,
  isRequest,
  isResponse,
  type JsonRpcMessage,
  type McpTransport,
} from "./jsonrpc";

// MCP client over any transport: initialize handshake, tool listing and calls, cancellation, and
// answers to server-initiated requests. Everything a server sends is treated as untrusted data.

export const PROTOCOL_VERSION = "2025-06-18";
const SUPPORTED_VERSIONS = new Set([PROTOCOL_VERSION, "2025-03-26", "2024-11-05"]);
export const CLIENT_INFO = { name: "tatvam", version: "0.1.0" };
export const MAX_TOOLS = 500;
const MAX_PAGES = 100;
const MAX_DESCRIPTION_CHARS = 4000;

export class McpTimeoutError extends Error {
  name = "McpTimeoutError";
}
export class McpAbortError extends Error {
  name = "McpAbortError";
}
/** The connection ended (process exit, dropped connection) or was closed. */
export class McpConnectionError extends Error {
  name = "McpConnectionError";
}

export type McpToolAnnotations = { title?: string; readOnlyHint?: boolean; openWorldHint?: boolean };
export type McpTool = {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: McpToolAnnotations;
};
export type McpContent = Record<string, unknown> & { type?: unknown };
export type CallToolResult = { content: McpContent[]; structuredContent?: Record<string, unknown>; isError: boolean };

const optionalString = z.string().optional().catch(undefined);
const optionalBoolean = z.boolean().optional().catch(undefined);
const toolSchema = z.object({
  name: z.string().min(1).max(512),
  title: optionalString,
  description: optionalString,
  inputSchema: z.record(z.string(), z.unknown()).optional().catch(undefined),
  annotations: z
    .object({ title: optionalString, readOnlyHint: optionalBoolean, openWorldHint: optionalBoolean })
    .optional()
    .catch(undefined),
});
const listResultSchema = z.object({ tools: z.array(z.unknown()), nextCursor: z.string().optional().catch(undefined) });
const initializeResultSchema = z.object({
  protocolVersion: z.string(),
  serverInfo: z.object({ name: optionalString, version: optionalString }).optional().catch(undefined),
});
const callResultSchema = z.object({
  content: z.array(z.record(z.string(), z.unknown())).optional().catch(undefined),
  structuredContent: z.record(z.string(), z.unknown()).optional().catch(undefined),
  isError: optionalBoolean,
});

function normalizeTool(tool: z.infer<typeof toolSchema>): McpTool {
  const clean = (value: string | undefined, max: number) => (value?.trim() ? value.trim().slice(0, max) : undefined);
  const annotations = tool.annotations
    ? Object.fromEntries(Object.entries(tool.annotations).filter(([, value]) => value !== undefined))
    : undefined;
  return {
    name: tool.name,
    title: clean(tool.title ?? tool.annotations?.title, 200),
    description: clean(tool.description, MAX_DESCRIPTION_CHARS),
    inputSchema: tool.inputSchema ?? {},
    ...(annotations && Object.keys(annotations).length ? { annotations } : {}),
  };
}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };
type RequestOptions = { timeoutMs?: number; signal?: AbortSignal; cancellable?: boolean };

export type McpClientOptions = {
  timeoutMs: number;
  /** After `notifications/tools/list_changed` and a successful refresh. */
  onToolsChanged?: (tools: McpTool[]) => void;
  /** The connection ended without `close()`; pending requests have already been rejected. */
  onClose?: (error: Error) => void;
};

export class McpClient {
  tools: McpTool[] = [];
  protocolVersion?: string;
  serverInfo?: { name?: string; version?: string };
  private nextId = 1;
  private readonly pending = new Map<string, Pending>();
  private closed = false;
  private refreshing = false;
  private refreshAgain = false;

  constructor(
    private readonly transport: McpTransport,
    private readonly options: McpClientOptions,
  ) {
    transport.onmessage = (message) => this.handle(message);
    transport.onclose = (error) => this.handleClose(error);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Handshake, then the first tool list. Closes the transport if anything fails. */
  async connect(signal?: AbortSignal): Promise<void> {
    try {
      await this.transport.start();
      const raw = await this.request(
        "initialize",
        { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO },
        // The spec forbids cancelling initialize.
        { signal, cancellable: false },
      );
      const result = initializeResultSchema.safeParse(raw);
      if (!result.success) throw new Error("The server sent an invalid initialize result.");
      if (!SUPPORTED_VERSIONS.has(result.data.protocolVersion))
        throw new Error(`The server requires MCP protocol version ${result.data.protocolVersion.slice(0, 40)}, which Tatvam does not support.`);
      this.protocolVersion = result.data.protocolVersion;
      this.serverInfo = result.data.serverInfo;
      this.transport.setProtocolVersion?.(result.data.protocolVersion);
      await this.notify("notifications/initialized");
      this.transport.listen?.();
      this.tools = await this.listTools(signal);
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async callTool(name: string, args: Record<string, unknown>, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<CallToolResult> {
    const raw = await this.request("tools/call", { name, arguments: args }, options);
    const result = callResultSchema.safeParse(raw);
    if (!result.success) throw new Error("The server sent an invalid tool result.");
    return {
      content: result.data.content ?? [],
      ...(result.data.structuredContent ? { structuredContent: result.data.structuredContent } : {}),
      isError: result.data.isError === true,
    };
  }

  /** Follows `nextCursor`, keeping at most 500 tools and skipping malformed or duplicate entries. */
  async listTools(signal?: AbortSignal): Promise<McpTool[]> {
    const tools: McpTool[] = [];
    const names = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const raw = await this.request("tools/list", cursor === undefined ? undefined : { cursor }, { signal });
      const result = listResultSchema.safeParse(raw);
      if (!result.success) throw new Error("The server sent an invalid tool list.");
      for (const item of result.data.tools) {
        const tool = toolSchema.safeParse(item);
        if (!tool.success || names.has(tool.data.name)) continue;
        names.add(tool.data.name);
        tools.push(normalizeTool(tool.data));
        if (tools.length >= MAX_TOOLS) return tools;
      }
      cursor = result.data.nextCursor;
      if (!cursor || cursors.has(cursor)) break;
      cursors.add(cursor);
    }
    return tools;
  }

  request(method: string, params?: Record<string, unknown>, options: RequestOptions = {}): Promise<unknown> {
    if (this.closed) return Promise.reject(new McpConnectionError("The MCP server is not connected."));
    const { timeoutMs = this.options.timeoutMs, signal, cancellable = true } = options;
    if (signal?.aborted) return Promise.reject(new McpAbortError("The request was cancelled."));
    const id = this.nextId++;
    const key = String(id);
    // Ends the transport's work for this request (an HTTP response stream) once it settles.
    const done = new AbortController();
    return new Promise((resolve, reject) => {
      const settle = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.pending.delete(key);
        done.abort();
      };
      const giveUp = (reason: string, error: Error) => {
        settle();
        if (cancellable) void this.notify("notifications/cancelled", { requestId: id, reason }).catch(() => {});
        reject(error);
      };
      const timer = setTimeout(
        () => giveUp("Request timed out", new McpTimeoutError(`No answer to ${method} within ${Math.round(timeoutMs / 100) / 10} s.`)),
        timeoutMs,
      );
      const onAbort = () => giveUp("Cancelled by the user", new McpAbortError("The request was cancelled."));
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(key, {
        resolve: (value) => {
          settle();
          resolve(value);
        },
        reject: (error) => {
          settle();
          reject(error);
        },
      });
      this.transport
        .send({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }, done.signal)
        .catch((error) => this.pending.get(key)?.reject(error instanceof Error ? error : new Error(String(error))));
    });
  }

  notify(method: string, params?: Record<string, unknown>): Promise<void> {
    if (this.closed) return Promise.reject(new McpConnectionError("The MCP server is not connected."));
    return this.transport.send({ jsonrpc: "2.0", method, ...(params ? { params } : {}) });
  }

  private handle(message: JsonRpcMessage) {
    if (this.closed) return;
    if (isResponse(message)) {
      const entry = this.pending.get(String(message.id));
      if (!entry) return;
      if (message.error) entry.reject(new JsonRpcError(message.error.message, message.error.code, message.error.data));
      else entry.resolve(message.result);
      return;
    }
    if (isRequest(message)) {
      // Tatvam declares no client capabilities, so ping is the only request it serves.
      const reply: JsonRpcMessage =
        message.method === "ping"
          ? { jsonrpc: "2.0", id: message.id, result: {} }
          : { jsonrpc: "2.0", id: message.id, error: { code: METHOD_NOT_FOUND, message: `Method not found: ${String(message.method).slice(0, 100)}` } };
      void this.transport.send(reply).catch(() => {});
      return;
    }
    if (isNotification(message) && message.method === "notifications/tools/list_changed") this.refreshTools();
  }

  /** Refreshes one at a time; a change announced during a refresh triggers one more. */
  private refreshTools() {
    if (this.refreshing) {
      this.refreshAgain = true;
      return;
    }
    this.refreshing = true;
    void (async () => {
      try {
        do {
          this.refreshAgain = false;
          try {
            this.tools = await this.listTools();
            if (!this.closed) this.options.onToolsChanged?.(this.tools);
          } catch {
            // Keep the previous list; a dropped connection is reported through onClose.
          }
        } while (this.refreshAgain && !this.closed);
      } finally {
        this.refreshing = false;
      }
    })();
  }

  private rejectAll(error: Error) {
    for (const entry of [...this.pending.values()]) entry.reject(error);
  }

  private handleClose(error: Error) {
    if (this.closed) return;
    this.closed = true;
    this.rejectAll(new McpConnectionError(error.message));
    this.options.onClose?.(error);
  }

  async close(): Promise<void> {
    if (this.closed) {
      await this.transport.close().catch(() => {});
      return;
    }
    this.closed = true;
    this.rejectAll(new McpConnectionError("The connection was closed."));
    await this.transport.close().catch(() => {});
  }
}
