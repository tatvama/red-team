// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { CompletionStreamParser, ModelError, ThinkTagSplitter, modelConnection, streamCompletion } from "./llm";

const sse = (...chunks: object[]) => chunks.map((item) => `data: ${JSON.stringify(item)}\n\n`).join("") + "data: [DONE]\n\n";
const delta = (value: object, finish: string | null = null) => ({ choices: [{ index: 0, delta: value, finish_reason: finish }] });

function streamResponse(body: string, status = 200, type = "text/event-stream") {
  return new Response(body, { status, headers: { "content-type": type } });
}

describe("ThinkTagSplitter", () => {
  it("splits a leading think block even when tags straddle chunks", () => {
    const splitter = new ThinkTagSplitter();
    const out = ["<thi", "nk>plan", " it</th", "ink>\n\nAnswer"].flatMap((part) => splitter.push(part));
    out.push(...splitter.flush());
    const reasoning = out.filter((item) => item.kind === "reasoning").map((item) => item.text).join("");
    const content = out.filter((item) => item.kind === "content").map((item) => item.text).join("");
    expect(reasoning).toBe("plan it");
    expect(content).toBe("Answer");
  });

  it("leaves think tags alone when they are not at the start", () => {
    const splitter = new ThinkTagSplitter();
    const out = [...splitter.push("Use <think> in XML"), ...splitter.flush()];
    expect(out).toEqual([{ kind: "content", text: "Use <think> in XML" }]);
  });

  it("treats an unterminated block as reasoning", () => {
    const splitter = new ThinkTagSplitter();
    const out = [...splitter.push("<think>still going"), ...splitter.flush()];
    expect(out.every((item) => item.kind === "reasoning")).toBe(true);
  });
});

describe("CompletionStreamParser", () => {
  it("collects content, both reasoning field names and streamed tool-call arguments", () => {
    const parser = new CompletionStreamParser();
    const body = sse(
      delta({ reasoning_content: "Thinking. " }),
      delta({ reasoning: "More." }),
      delta({ content: "Let me look." }),
      delta({ tool_calls: [{ index: 0, id: "call_1", function: { name: "read_file", arguments: "" } }] }),
      delta({ tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] }),
      delta({ tool_calls: [{ index: 0, function: { arguments: '"a.ts"}' } }] }),
      delta({}, "tool_calls"),
    );
    // Feed in awkward slices to exercise line buffering.
    const deltas = [];
    for (let index = 0; index < body.length; index += 7) deltas.push(...parser.push(body.slice(index, index + 7)));
    const { result } = parser.finish();
    expect(deltas.map((item) => item.kind)).toEqual(["reasoning", "reasoning", "content"]);
    expect(result.reasoning).toBe("Thinking. More.");
    expect(result.content).toBe("Let me look.");
    expect(result.finishReason).toBe("tool_calls");
    expect(result.toolCalls).toEqual([{ id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"a.ts"}' } }]);
  });

  it("accepts whole tool calls with object arguments and generates missing ids", () => {
    const parser = new CompletionStreamParser();
    parser.push(sse(delta({ tool_calls: [{ function: { name: "calculator", arguments: { expression: "1+1" } } }] })));
    const { result } = parser.finish();
    expect(result.toolCalls[0].id).toMatch(/^call_/);
    expect(JSON.parse(result.toolCalls[0].function.arguments)).toEqual({ expression: "1+1" });
  });

  it("throws a ModelError when the stream reports an error", () => {
    const parser = new CompletionStreamParser();
    expect(() => parser.push(sse({ error: { message: "out of memory" } }))).toThrow(ModelError);
  });
});

describe("streamCompletion", () => {
  const request = {
    provider: "ollama" as const,
    model: "qwen",
    messages: [{ role: "user" as const, content: "hi" }],
    maxTokens: 100,
    signal: new AbortController().signal,
  };

  it("streams deltas and returns the final result", async () => {
    const fetchMock = vi.fn(async () => streamResponse(sse(delta({ content: "Hel" }), delta({ content: "lo" }, "stop"))));
    vi.stubGlobal("fetch", fetchMock);
    const seen: string[] = [];
    const result = await streamCompletion({ ...request, tools: [], onDelta: (item) => seen.push(item.text) });
    expect(seen.join("")).toBe("Hello");
    expect(result.content).toBe("Hello");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe("http://127.0.0.1:11434/v1/chat/completions");
    expect(JSON.parse(String(init.body))).not.toHaveProperty("tools");
  });

  it("reports models that cannot use tools", async () => {
    vi.stubGlobal("fetch", async () => streamResponse('{"error":{"message":"qwen does not support tools"}}', 400, "application/json"));
    const tools = [{ type: "function" as const, function: { name: "x", description: "", parameters: {} } }];
    await expect(streamCompletion({ ...request, tools, onDelta: () => {} })).rejects.toMatchObject({ kind: "tools_unsupported" });
  });

  it("explains a rejected API key", async () => {
    vi.stubGlobal("fetch", async () => streamResponse("{}", 401, "application/json"));
    await expect(streamCompletion({ ...request, tools: [], onDelta: () => {} })).rejects.toThrow(/API key/);
  });

  it("refuses to run when the GPU connection is not configured", async () => {
    vi.stubEnv("GPU_BASE_URL", "");
    await expect(streamCompletion({ ...request, provider: "gpu", tools: [], onDelta: () => {} })).rejects.toMatchObject({
      kind: "unconfigured",
    });
  });
});

describe("modelConnection", () => {
  it("lists models from the server and sends the API key", async () => {
    vi.stubEnv("GPU_BASE_URL", "https://gpu.example.com/v1/");
    vi.stubEnv("GPU_API_KEY", "test-key");
    const fetchMock = vi.fn(async () => Response.json({ data: [{ id: "llama" }, { id: "llama" }, { id: "bad\u0000" }, {}] }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(modelConnection("gpu")).resolves.toEqual({ provider: "gpu", state: "ready", models: ["llama"] });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe("https://gpu.example.com/v1/models");
    expect(init.headers).toEqual({ Authorization: "Bearer test-key" });
  });

  it("rejects plain HTTP to a non-loopback host unless explicitly allowed", async () => {
    vi.stubEnv("GPU_BASE_URL", "http://10.0.0.5:8000/v1");
    vi.stubGlobal("fetch", async () => Response.json({ data: [{ id: "m" }] }));
    await expect(modelConnection("gpu")).resolves.toMatchObject({ state: "unconfigured" });
    vi.stubEnv("ALLOW_HTTP_MODEL_URLS", "true");
    await expect(modelConnection("gpu")).resolves.toMatchObject({ state: "ready" });
  });

  it("rejects URLs with embedded credentials and reports unreachable servers as offline", async () => {
    vi.stubEnv("GPU_BASE_URL", "https://user:pass@gpu.example.com/v1");
    await expect(modelConnection("gpu")).resolves.toMatchObject({ state: "unconfigured" });
    vi.stubEnv("GPU_BASE_URL", "https://gpu.example.com/v1");
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });
    await expect(modelConnection("gpu")).resolves.toMatchObject({ state: "offline" });
  });
});
