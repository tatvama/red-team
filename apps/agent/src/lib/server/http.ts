import "server-only";
import type { AgentEvent } from "@/lib/contract";
import { decideAccess } from "./auth";

export function failure(message: string, status: number): Response {
  return Response.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
}

/**
 * Every API route starts with `const denied = await guard(request); if (denied) return denied;`.
 * The app can edit files and run commands, so it answers only loopback hosts, or allow-listed
 * hosts with a valid session (see auth.ts). Same-origin is enforced for browser requests.
 */
export async function guard(request: Request, session: "required" | "optional" = "required"): Promise<Response | null> {
  const decision = await decideAccess(request, session);
  if (decision.allowed) return null;
  return decision.status === 401
    ? failure("Sign in to continue.", 401)
    : failure("This address is not allowed to use Tatvam. Open it on this computer or add the host to ALLOWED_HOSTS.", 403);
}

export async function readJson(request: Request, limitBytes = 400_000): Promise<unknown> {
  if (!request.headers.get("content-type")?.startsWith("application/json")) throw new Error("JSON required");
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > limitBytes) throw new Error("Body too large");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("Missing body");
  const decoder = new TextDecoder();
  let text = "";
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limitBytes) throw new Error("Body too large");
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return JSON.parse(text + decoder.decode()) as unknown;
}

/**
 * Streams AgentEvents as newline-delimited JSON. The work stops (and saves partial output) when the
 * client disconnects or presses Stop, because both abort the signal handed to `work`.
 */
export function ndjsonResponse(
  request: Request,
  work: (emit: (event: AgentEvent) => void, signal: AbortSignal) => Promise<void>,
  onFinish: () => void,
): Response {
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.signal.addEventListener("abort", abort, { once: true });
  const encoder = new TextEncoder();
  let closed = false;
  const body = new ReadableStream<Uint8Array>({
    async start(output) {
      const emit = (event: AgentEvent) => {
        if (!closed) output.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };
      try {
        await work(emit, controller.signal);
      } catch {
        emit({ type: "error", message: "The agent stopped unexpectedly. Retry to continue." });
      } finally {
        request.signal.removeEventListener("abort", abort);
        onFinish();
        if (!closed) {
          closed = true;
          output.close();
        }
      }
    },
    cancel() {
      closed = true;
      controller.abort();
    },
  });
  return new Response(body, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Accel-Buffering": "no",
    },
  });
}
