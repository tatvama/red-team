// Test-only helpers for the training job tests: scripted models and temporary suites.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ModelError, type CompletionFn, type CompletionRequest, type CompletionResult, type WireToolCall } from "../llm";

export type Step = Partial<CompletionResult> & {
  content?: string;
  error?: Error;
  /** Waits for this promise (or the request's abort) before answering. */
  wait?: Promise<void>;
};

let callCounter = 0;
export function call(name: string, args: object | string): WireToolCall {
  callCounter++;
  return {
    id: `call_${callCounter}`,
    type: "function",
    function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) },
  };
}

export function firstUserMessage(request: CompletionRequest): string {
  const message = request.messages.find((item) => item.role === "user");
  return message?.content ?? "";
}

function abortable(wait: Promise<void>, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new ModelError("Stopped.", "interrupted"));
    const onAbort = () => reject(new ModelError("Stopped.", "interrupted"));
    signal.addEventListener("abort", onAbort, { once: true });
    wait.then(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, reject);
  });
}

/**
 * A scripted model. `script` picks the steps for a conversation from its first user message; each
 * model call in that conversation consumes the next step.
 */
export function scriptedModel(script: (prompt: string, request: CompletionRequest) => Step[] | undefined) {
  const queues = new Map<string, Step[]>();
  const requests: CompletionRequest[] = [];
  const complete: CompletionFn = async (request) => {
    requests.push(request);
    const prompt = firstUserMessage(request);
    const key = `${request.model}\u0000${prompt}`;
    if (!queues.has(key)) queues.set(key, [...(script(prompt, request) ?? [])]);
    const step = queues.get(key)!.shift();
    if (!step) throw new Error(`No scripted step left for "${prompt.slice(0, 40)}"`);
    if (step.wait) await abortable(step.wait, request.signal);
    if (step.content) request.onDelta({ kind: "content", text: step.content });
    if (step.error) throw step.error;
    return {
      content: step.content ?? "",
      reasoning: "",
      toolCalls: step.toolCalls ?? [],
      finishReason: step.finishReason ?? (step.toolCalls?.length ? "tool_calls" : "stop"),
    };
  };
  return { complete, requests };
}

/** A promise with its resolver, to hold a scripted model until a test releases it. */
export function gate() {
  let open = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/** Writes `suites/<id>.json` and fixture folders under `root` (used as EVALS_DIR). */
export function writeSuite(root: string, suite: { id: string } & Record<string, unknown>, fixtures: Record<string, Record<string, string>> = {}) {
  mkdirSync(path.join(root, "suites"), { recursive: true });
  writeFileSync(path.join(root, "suites", `${suite.id}.json`), JSON.stringify(suite, null, 2));
  for (const [name, files] of Object.entries(fixtures))
    for (const [file, content] of Object.entries(files)) {
      const target = path.join(root, "fixtures", name, file);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
}

/** Polls until `check` returns a value (or throws after `timeoutMs`). */
export async function eventually<T>(check: () => T | null | undefined | false, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("Timed out waiting for a condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
