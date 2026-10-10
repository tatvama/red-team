import "server-only";

// JSON-RPC 2.0 message shapes used by MCP, and the transport contract the client talks through.

export type JsonRpcId = string | number;
export type JsonRpcErrorObject = { code: number; message: string; data?: unknown };

/** One loose shape for requests, notifications and responses; see the `is*` helpers. */
export type JsonRpcMessage = {
  jsonrpc: "2.0";
  id?: JsonRpcId | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: JsonRpcErrorObject;
};

/** Upper bound for one message (stdio) or one HTTP response body. */
export const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;

export const METHOD_NOT_FOUND = -32601;

export class JsonRpcError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "JsonRpcError";
  }
}

const hasId = (message: JsonRpcMessage) => typeof message.id === "string" || typeof message.id === "number";

export function isRequest(message: JsonRpcMessage): boolean {
  return typeof message.method === "string" && hasId(message);
}

export function isNotification(message: JsonRpcMessage): boolean {
  return typeof message.method === "string" && !hasId(message);
}

export function isResponse(message: JsonRpcMessage): boolean {
  return message.method === undefined && hasId(message) && ("result" in message || "error" in message);
}

function toMessage(value: unknown): JsonRpcMessage | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.method !== "string" && record.id === undefined) return null;
  const message = { ...record, jsonrpc: "2.0" } as JsonRpcMessage;
  if (message.error !== undefined) {
    const error = message.error as unknown as Record<string, unknown> | null;
    message.error = {
      code: typeof error?.code === "number" ? error.code : -32603,
      message: typeof error?.message === "string" ? error.message : "Unknown error",
      ...(error && "data" in error ? { data: error.data } : {}),
    };
  }
  return message;
}

/** Accepts one message or a batch array; anything that is not a JSON-RPC message is dropped. */
export function toMessages(value: unknown): JsonRpcMessage[] {
  const items = Array.isArray(value) ? value : [value];
  return items.map(toMessage).filter((message): message is JsonRpcMessage => message !== null);
}

/**
 * A bidirectional JSON-RPC channel. `onclose` fires once, only when the connection ends without
 * `close()` being called (process exit, dropped connection, expired session).
 */
export interface McpTransport {
  readonly kind: "stdio" | "http";
  onmessage?: (message: JsonRpcMessage) => void;
  onclose?: (error: Error) => void;
  start(): Promise<void>;
  /**
   * Resolves once the message is written (stdio) or fully handled (HTTP). For HTTP requests the
   * response arrives through `onmessage` before this resolves; it rejects if none arrives.
   */
  send(message: JsonRpcMessage, signal?: AbortSignal): Promise<void>;
  /** Called with the negotiated version after `initialize` (sent as a header over HTTP). */
  setProtocolVersion?(version: string): void;
  /** Called after initialization so HTTP can open its server-to-client event stream. */
  listen?(): void;
  close(): Promise<void>;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
