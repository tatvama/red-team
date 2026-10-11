import "server-only";
import type { ModelConnection, Provider } from "@/lib/contract";
import { modelEndpoint } from "./config";

// OpenAI-compatible client. Works with Ollama (/v1), vLLM, llama.cpp server, LM Studio and similar.

export type WireToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
export type WireMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; tool_calls?: WireToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };
export type WireTool = {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

export type CompletionDelta = { kind: "reasoning" | "content"; text: string };
export type CompletionResult = {
  content: string;
  reasoning: string;
  toolCalls: WireToolCall[];
  finishReason: string | null;
};

export type CompletionRequest = {
  provider: Provider;
  model: string;
  messages: WireMessage[];
  tools: WireTool[];
  maxTokens: number;
  temperature?: number;
  signal: AbortSignal;
  onDelta: (delta: CompletionDelta) => void;
};
export type CompletionFn = (request: CompletionRequest) => Promise<CompletionResult>;

export class ModelError extends Error {
  constructor(
    message: string,
    readonly kind: "unconfigured" | "unreachable" | "rejected" | "tools_unsupported" | "interrupted",
    /** HTTP status when the server answered with an error. */
    readonly status?: number,
  ) {
    super(message);
  }

  /** True when another model might succeed: the server is down or failed on its side. */
  get retryable(): boolean {
    return this.kind === "unreachable" || this.kind === "unconfigured" || (this.status !== undefined && this.status >= 500);
  }
}

const MAX_RESPONSE_BYTES = 8_000_000;
const MAX_MODEL_LIST_BYTES = 1_000_000;

async function readLimited(response: Response, limit: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      size += value.byteLength;
      if (size > limit) throw new Error("Response too large");
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export async function modelConnection(provider: Provider, signal?: AbortSignal): Promise<ModelConnection> {
  const endpoint = modelEndpoint(provider);
  if (!endpoint) return { provider, state: "unconfigured", models: [] };
  try {
    const timeout = AbortSignal.timeout(5000);
    const response = await fetch(new URL("models", endpoint.base), {
      headers: endpoint.headers,
      cache: "no-store",
      redirect: "error",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok) {
      await response.body?.cancel();
      return { provider, state: "offline", models: [] };
    }
    const data = JSON.parse(await readLimited(response, MAX_MODEL_LIST_BYTES)) as { data?: unknown };
    if (!Array.isArray(data.data)) return { provider, state: "offline", models: [] };
    const models = new Set<string>();
    for (const item of data.data as unknown[]) {
      const id = item && typeof item === "object" && "id" in item ? item.id : null;
      if (typeof id === "string" && id.trim() && id.length <= 200 && !/[\x00-\x1f]/.test(id)) models.add(id);
    }
    const list = [...models].slice(0, 200);
    return { provider, state: list.length ? "ready" : "empty", models: list };
  } catch {
    return { provider, state: "offline", models: [] };
  }
}

/**
 * Splits `<think>…</think>` reasoning out of content for models that inline it (Qwen, DeepSeek R1
 * on some servers). Only a block at the very start of the reply counts, so code that mentions the
 * tag later is left alone. Tags split across chunks are buffered.
 */
export class ThinkTagSplitter {
  private state: "start" | "thinking" | "content" = "start";
  private buffer = "";

  push(text: string): CompletionDelta[] {
    this.buffer += text;
    const out: CompletionDelta[] = [];
    while (this.buffer) {
      if (this.state === "start") {
        const trimmed = this.buffer.trimStart();
        if (!trimmed) return out;
        if (trimmed.startsWith("<think>")) {
          this.buffer = trimmed.slice("<think>".length);
          this.state = "thinking";
        } else if ("<think>".startsWith(trimmed)) {
          return out; // could still become the opening tag
        } else {
          this.state = "content";
        }
      } else if (this.state === "thinking") {
        const end = this.buffer.indexOf("</think>");
        if (end !== -1) {
          if (end > 0) out.push({ kind: "reasoning", text: this.buffer.slice(0, end) });
          this.buffer = this.buffer.slice(end + "</think>".length).replace(/^\s+/, "");
          this.state = "content";
          continue;
        }
        // Hold back a possible partial closing tag.
        const keep = partialSuffix(this.buffer, "</think>");
        const emit = this.buffer.slice(0, this.buffer.length - keep);
        if (emit) out.push({ kind: "reasoning", text: emit });
        this.buffer = this.buffer.slice(this.buffer.length - keep);
        return out;
      } else {
        out.push({ kind: "content", text: this.buffer });
        this.buffer = "";
      }
    }
    return out;
  }

  flush(): CompletionDelta[] {
    const rest = this.buffer;
    this.buffer = "";
    if (!rest) return [];
    return [{ kind: this.state === "thinking" ? "reasoning" : "content", text: rest }];
  }
}

function partialSuffix(text: string, tag: string): number {
  for (let length = Math.min(tag.length - 1, text.length); length > 0; length--) {
    if (text.endsWith(tag.slice(0, length))) return length;
  }
  return 0;
}

type StreamChunk = {
  error?: unknown;
  choices?: {
    delta?: {
      content?: unknown;
      reasoning?: unknown;
      reasoning_content?: unknown;
      tool_calls?: { index?: unknown; id?: unknown; function?: { name?: unknown; arguments?: unknown } }[];
    };
    finish_reason?: unknown;
  }[];
};

/** Incremental parser for an OpenAI-style `text/event-stream` chat completion. */
export class CompletionStreamParser {
  private buffer = "";
  private content = "";
  private reasoning = "";
  private finishReason: string | null = null;
  private calls = new Map<number, { id: string; name: string; arguments: string }>();
  private think = new ThinkTagSplitter();
  done = false;

  push(chunk: string): CompletionDelta[] {
    this.buffer += chunk;
    const out: CompletionDelta[] = [];
    let newline: number;
    while (!this.done && (newline = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newline).trimEnd();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      if (payload === "[DONE]") {
        this.done = true;
        break;
      }
      out.push(...this.apply(JSON.parse(payload) as StreamChunk));
    }
    return out;
  }

  private apply(data: StreamChunk): CompletionDelta[] {
    if (data.error) {
      const message = typeof data.error === "object" && data.error && "message" in data.error ? data.error.message : data.error;
      throw new ModelError(`The model reported an error: ${String(message).slice(0, 300)}`, "rejected");
    }
    const choice = data.choices?.[0];
    if (!choice) return [];
    const out: CompletionDelta[] = [];
    const delta = choice.delta ?? {};
    const reasoning = typeof delta.reasoning_content === "string" ? delta.reasoning_content : delta.reasoning;
    if (typeof reasoning === "string" && reasoning) out.push({ kind: "reasoning", text: reasoning });
    if (typeof delta.content === "string" && delta.content) out.push(...this.think.push(delta.content));
    for (const [position, part] of (delta.tool_calls ?? []).entries()) {
      const index = typeof part.index === "number" ? part.index : position;
      const call = this.calls.get(index) ?? { id: "", name: "", arguments: "" };
      if (typeof part.id === "string" && part.id) call.id = part.id;
      if (typeof part.function?.name === "string") call.name += part.function.name;
      if (typeof part.function?.arguments === "string") call.arguments += part.function.arguments;
      else if (part.function?.arguments && typeof part.function.arguments === "object")
        call.arguments = JSON.stringify(part.function.arguments);
      this.calls.set(index, call);
    }
    if (typeof choice.finish_reason === "string") this.finishReason = choice.finish_reason;
    for (const item of out) this.record(item);
    return out;
  }

  private record(delta: CompletionDelta) {
    if (delta.kind === "reasoning") this.reasoning += delta.text;
    else this.content += delta.text;
  }

  /** Call once the stream ends. Returns trailing buffered text plus the final result. */
  finish(): { deltas: CompletionDelta[]; result: CompletionResult } {
    const deltas = this.think.flush();
    for (const item of deltas) this.record(item);
    const toolCalls = [...this.calls.entries()]
      .sort(([a], [b]) => a - b)
      .filter(([, call]) => call.name)
      .map(([, call]) => ({
        id: call.id || `call_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`,
        type: "function" as const,
        function: { name: call.name, arguments: call.arguments || "{}" },
      }));
    return {
      deltas,
      result: { content: this.content, reasoning: this.reasoning, toolCalls, finishReason: this.finishReason },
    };
  }
}

function looksLikeToolsUnsupported(body: string): boolean {
  return /does not support tools|tool(s|_choice)? (is |are )?not supported|unsupported.*tool/i.test(body);
}

export const streamCompletion: CompletionFn = async (request) => {
  const endpoint = modelEndpoint(request.provider);
  if (!endpoint) throw new ModelError("Set up this model connection in .env.local first.", "unconfigured");

  let response: Response;
  try {
    response = await fetch(new URL("chat/completions", endpoint.base), {
      method: "POST",
      cache: "no-store",
      redirect: "error",
      signal: request.signal,
      headers: { ...endpoint.headers, "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify({
        model: request.model,
        stream: true,
        max_tokens: request.maxTokens,
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
        messages: request.messages,
        ...(request.tools.length ? { tools: request.tools, tool_choice: "auto" } : {}),
      }),
    });
  } catch {
    if (request.signal.aborted) throw new ModelError("Stopped.", "interrupted");
    throw new ModelError("Could not reach the model server. Check that it is running, then retry.", "unreachable");
  }

  if (!response.ok) {
    const body = await readLimited(response, 20_000).catch(() => "");
    if (request.tools.length && response.status === 400 && looksLikeToolsUnsupported(body))
      throw new ModelError("This model does not support tools.", "tools_unsupported");
    if (response.status === 404)
      throw new ModelError(`Model "${request.model}" was not found on the server.`, "rejected", 404);
    if (response.status === 401 || response.status === 403)
      throw new ModelError("The model server rejected the API key. Check GPU_API_KEY.", "rejected", response.status);
    throw new ModelError(`The model server returned HTTP ${response.status}.`, "rejected", response.status);
  }
  if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) {
    await response.body?.cancel();
    throw new ModelError("The model server did not return a stream.", "rejected");
  }

  const parser = new CompletionStreamParser();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  try {
    while (!parser.done) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new ModelError("The model reply was too large.", "rejected");
      for (const delta of parser.push(decoder.decode(value, { stream: true }))) request.onDelta(delta);
    }
  } catch (error) {
    if (request.signal.aborted) throw new ModelError("Stopped.", "interrupted");
    if (error instanceof ModelError) throw error;
    throw new ModelError("The reply was interrupted. Retry when your model is available.", "unreachable");
  } finally {
    await reader.cancel().catch(() => {});
  }
  const { deltas, result } = parser.finish();
  for (const delta of deltas) request.onDelta(delta);
  return result;
};
