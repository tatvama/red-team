import "server-only";
import {
  MAX_MESSAGE_BYTES,
  errorMessage,
  isRequest,
  isResponse,
  toMessages,
  type JsonRpcMessage,
  type McpTransport,
} from "./jsonrpc";

// Streamable HTTP transport (MCP 2025-06-18): every client message is a POST; the answer is JSON or
// an SSE stream. An optional GET stream carries server-initiated notifications such as list_changed.

const ACCEPT_BOTH = "application/json, text/event-stream";
const DELETE_TIMEOUT_MS = 3000;
const LOOPBACK_HOSTS = new Set(["localhost", "[::1]"]);

export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase()) || /^127(?:\.\d{1,3}){3}$/.test(hostname);
}

/** Only https, or plain http to loopback. Credentials belong in headers, not in the URL. */
export function checkServerUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("The MCP server URL is not a valid URL.");
  }
  if (url.username || url.password)
    throw new Error("Remove the credentials from the MCP server URL and send them in \"headers\" instead.");
  const loopbackHttp = url.protocol === "http:" && isLoopbackHost(url.hostname);
  if (url.protocol !== "https:" && !loopbackHttp)
    throw new Error("MCP server URLs must use https:// (plain http:// is only allowed for localhost and 127.0.0.1).");
  url.hash = "";
  return url;
}

export type SseEvent = { event: string; data: string; id?: string };

/** Incremental text/event-stream parser. */
export class SseParser {
  private buffer = "";
  private data: string[] = [];
  private dataSize = 0;
  private event = "";
  lastEventId?: string;
  retryMs?: number;

  constructor(private readonly maxEventChars = MAX_MESSAGE_BYTES) {}

  feed(text: string): SseEvent[] {
    let pending = this.buffer + text;
    // A CR at the very end may be the first half of a CRLF split across chunks.
    let hold = "";
    if (pending.endsWith("\r")) {
      hold = "\r";
      pending = pending.slice(0, -1);
    }
    const lines = pending.split(/\r\n|\r|\n/);
    this.buffer = (lines.pop() ?? "") + hold;
    if (this.buffer.length > this.maxEventChars) throw new Error("The server sent an event larger than 4 MB.");
    const events: SseEvent[] = [];
    for (const line of lines) {
      if (line === "") {
        if (this.data.length > 0)
          events.push({ event: this.event || "message", data: this.data.join("\n"), id: this.lastEventId });
        this.data = [];
        this.dataSize = 0;
        this.event = "";
        continue;
      }
      if (line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
      if (field === "data") {
        this.dataSize += value.length + 1;
        if (this.dataSize > this.maxEventChars) throw new Error("The server sent an event larger than 4 MB.");
        this.data.push(value);
      } else if (field === "event") this.event = value;
      else if (field === "id" && !value.includes("\0")) this.lastEventId = value;
      else if (field === "retry" && /^\d+$/.test(value)) this.retryMs = Number(value);
    }
    return events;
  }
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

function describeFetchError(error: unknown): string {
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : "";
  return cause || errorMessage(error);
}

/** Reads a body as text, refusing more than `limit` bytes. */
async function readLimited(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error("The server's response is larger than 4 MB.");
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return text + decoder.decode();
}

async function discard(response: Response) {
  await response.body?.cancel().catch(() => {});
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

export class HttpTransport implements McpTransport {
  readonly kind = "http";
  onmessage?: (message: JsonRpcMessage) => void;
  onclose?: (error: Error) => void;
  private url?: URL;
  private sessionId?: string;
  private protocolVersion?: string;
  private readonly lifetime = new AbortController();
  private closed = false;
  private listening = false;

  constructor(
    private readonly rawUrl: string,
    private readonly headers: Record<string, string> = {},
  ) {}

  async start(): Promise<void> {
    this.url = checkServerUrl(this.rawUrl);
  }

  setProtocolVersion(version: string) {
    this.protocolVersion = version;
  }

  private buildHeaders(accept: string): Headers {
    const headers = new Headers(this.headers);
    headers.set("Accept", accept);
    if (this.sessionId) headers.set("Mcp-Session-Id", this.sessionId);
    if (this.protocolVersion) headers.set("MCP-Protocol-Version", this.protocolVersion);
    return headers;
  }

  /** The connection is gone (network failure or expired session): report it once. */
  private fail(error: Error) {
    if (this.closed) return;
    this.closed = true;
    this.lifetime.abort();
    this.onclose?.(error);
  }

  async send(message: JsonRpcMessage, signal?: AbortSignal): Promise<void> {
    if (!this.url || this.closed) throw new Error("The MCP connection is closed.");
    const initialize = message.method === "initialize";
    const headers = this.buildHeaders(ACCEPT_BOTH);
    headers.set("Content-Type", "application/json");
    const abort = signal ? AbortSignal.any([this.lifetime.signal, signal]) : this.lifetime.signal;
    let response: Response;
    try {
      response = await fetch(this.url, { method: "POST", headers, body: JSON.stringify(message), redirect: "manual", signal: abort });
    } catch (error) {
      if (abort.aborted || isAbort(error)) throw error;
      const failure = new Error(`Could not reach the MCP server: ${describeFetchError(error)}`);
      if (!initialize) this.fail(failure);
      throw failure;
    }

    if ((response.status >= 300 && response.status < 400) || response.type === "opaqueredirect") {
      await discard(response);
      throw new Error(`The MCP server answered with a redirect (HTTP ${response.status}). Redirects are not followed; put the final URL in the MCP config.`);
    }
    if (response.status === 404 && this.sessionId && !initialize) {
      await discard(response);
      const expired = new Error("The MCP session expired (HTTP 404). Restart the server to reconnect.");
      this.fail(expired);
      throw expired;
    }
    if (!response.ok) {
      const detail = (await readLimited(response, 64 * 1024).catch(() => "")).trim().slice(0, 300);
      throw new Error(`The MCP server answered HTTP ${response.status}${detail ? `: ${detail}` : ""}.`);
    }
    if (initialize) {
      const session = response.headers.get("mcp-session-id");
      if (session && /^[\x21-\x7e]{1,512}$/.test(session)) this.sessionId = session;
    }
    if (!isRequest(message)) return discard(response);
    if (response.status === 202) throw new Error("The MCP server accepted the request but sent no answer.");

    const wanted = String(message.id);
    let answered = false;
    const deliver = (value: unknown) => {
      for (const item of toMessages(value)) {
        if (isResponse(item) && String(item.id) === wanted) answered = true;
        this.onmessage?.(item);
      }
    };
    const type = (response.headers.get("content-type") ?? "").toLowerCase();
    if (type.includes("text/event-stream")) {
      await this.readEvents(response, (data) => {
        deliver(data);
        return answered;
      });
    } else if (type.includes("application/json")) {
      const text = await readLimited(response, MAX_MESSAGE_BYTES);
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        throw new Error("The MCP server sent invalid JSON.");
      }
      deliver(value);
    } else {
      await discard(response);
      throw new Error(`The MCP server sent an unexpected content type (${type || "none"}).`);
    }
    if (!answered) throw new Error("The MCP server ended its response without answering.");
  }

  /**
   * Feeds parsed JSON from each SSE event to `onData` until it returns true or the stream ends.
   * At most 4 MB are read from one response.
   */
  private async readEvents(response: Response, onData: (value: unknown) => boolean, limit = MAX_MESSAGE_BYTES, parser = new SseParser()) {
    const reader = response.body?.getReader();
    if (!reader) return;
    const decoder = new TextDecoder();
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) throw new Error("The server's response is larger than 4 MB.");
        for (const event of parser.feed(decoder.decode(value, { stream: true }))) {
          if (event.event !== "message") continue;
          let data: unknown;
          try {
            data = JSON.parse(event.data);
          } catch {
            continue;
          }
          if (onData(data)) return;
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
  }

  /** Opens the optional GET stream for server-initiated messages; servers without one answer 405. */
  listen() {
    if (this.listening || this.closed || !this.url) return;
    this.listening = true;
    void this.listenLoop(this.url);
  }

  private async listenLoop(url: URL) {
    let delay = 1000;
    const parser = new SseParser();
    while (!this.closed) {
      let received = false;
      try {
        const headers = this.buildHeaders("text/event-stream");
        if (parser.lastEventId) headers.set("Last-Event-ID", parser.lastEventId);
        const response = await fetch(url, { method: "GET", headers, redirect: "manual", signal: this.lifetime.signal });
        const type = (response.headers.get("content-type") ?? "").toLowerCase();
        if (!response.ok || !type.includes("text/event-stream")) return discard(response);
        // Long-lived stream: the 4 MB limit applies per event (enforced by the parser).
        await this.readEvents(
          response,
          (data) => {
            received = true;
            for (const item of toMessages(data)) this.onmessage?.(item);
            return this.closed;
          },
          Number.POSITIVE_INFINITY,
          parser,
        );
      } catch {
        if (this.closed) return;
      }
      if (this.closed) return;
      delay = received ? 1000 : Math.min(delay * 2, 60_000);
      await sleep(Math.max(500, parser.retryMs ?? delay), this.lifetime.signal);
    }
  }

  /** Aborts everything in flight and ends the session with DELETE. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.lifetime.abort();
    if (!this.url || !this.sessionId) return;
    try {
      const response = await fetch(this.url, {
        method: "DELETE",
        headers: this.buildHeaders(ACCEPT_BOTH),
        redirect: "manual",
        signal: AbortSignal.timeout(DELETE_TIMEOUT_MS),
      });
      await discard(response);
    } catch {
      // Best effort: the server expires the session on its own.
    }
  }
}
