import type { z } from "zod";
import type {
  AgentRequest,
  ApprovalRequest,
  ConversationDetail,
  ConversationSummary,
  DefaultWorkspaceView,
  GitAction,
  GitActionResult,
  GitChanges,
  mcpActionSchema,
  McpServerView,
  ModelConnection,
  Provider,
  RestoreCheckpointRequest,
  RestoreCheckpointResult,
  SessionView,
  SettingsUpdate,
  SettingsView,
} from "@/lib/contract";
import { navigateTo } from "./navigation";

/** An HTTP or network failure carrying a message that is safe to show to the user. */
export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

/** A user-facing message for anything thrown by these helpers or by a stream read. */
export function errorMessage(error: unknown, fallback = "Something went wrong. Please try again."): string {
  return error instanceof ApiError ? error.message : fallback;
}

async function readError(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    if (typeof body === "object" && body !== null && "error" in body && typeof body.error === "string" && body.error) {
      return body.error;
    }
  } catch {
    // Not JSON; fall through to a generic message.
  }
  if (response.status === 404) return "Not found.";
  return `The server returned an error (${response.status}).`;
}

type RequestOptions = RequestInit & {
  /**
   * A 401 normally means the remote session expired, so the browser goes to the sign-in page.
   * Sign-in itself turns this off: there a 401 only means the token was wrong.
   */
  redirectOnUnauthorized?: boolean;
};

export const LOGIN_PATH = "/login";

async function request(path: string, options: RequestOptions = {}): Promise<Response> {
  const { redirectOnUnauthorized = true, ...init } = options;
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: init.body ? { "Content-Type": "application/json", ...init.headers } : init.headers,
    });
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new ApiError("Could not reach the Tatvam server. Check that it is running.", 0);
  }
  if (response.status === 401 && redirectOnUnauthorized) {
    navigateTo(LOGIN_PATH);
    throw new ApiError("Your session has expired. Sign in again.", 401);
  }
  if (!response.ok) throw new ApiError(await readError(response), response.status);
  return response;
}

async function requestJson<T>(path: string, init?: RequestOptions): Promise<T> {
  const response = await request(path, init);
  return (await response.json()) as T;
}

const postJson = <T>(path: string, body: unknown): Promise<T> =>
  requestJson(path, { method: "POST", body: JSON.stringify(body) });

async function requestStream(path: string, body: unknown, signal: AbortSignal): Promise<ReadableStream<Uint8Array>> {
  const response = await request(path, { method: "POST", body: JSON.stringify(body), signal });
  if (!response.body) throw new ApiError("The server sent an empty response.", response.status);
  return response.body;
}

const conversationPath = (id: string) => `/api/conversations/${encodeURIComponent(id)}`;

export function fetchModels(provider: Provider, signal?: AbortSignal): Promise<ModelConnection> {
  return requestJson(`/api/models?provider=${provider}`, { signal });
}

export async function fetchConversations(): Promise<ConversationSummary[]> {
  const body = await requestJson<{ conversations: ConversationSummary[] }>("/api/conversations");
  return body.conversations;
}

export function fetchConversation(id: string): Promise<ConversationDetail> {
  return requestJson(conversationPath(id));
}

export function renameConversation(id: string, title: string): Promise<ConversationSummary> {
  return requestJson(conversationPath(id), { method: "PATCH", body: JSON.stringify({ title }) });
}

export async function deleteConversation(id: string): Promise<void> {
  await request(conversationPath(id), { method: "DELETE" });
}

export function fetchSettings(): Promise<SettingsView> {
  return requestJson("/api/settings");
}

export function saveSettings(update: SettingsUpdate): Promise<SettingsView> {
  return requestJson("/api/settings", { method: "PUT", body: JSON.stringify(update) });
}

export async function deleteMemory(id: string): Promise<void> {
  await request(`/api/memories/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** Starts or resumes an agent run. Resolves once the server accepts it, with the NDJSON event stream. */
export function startAgent(body: AgentRequest, signal: AbortSignal): Promise<ReadableStream<Uint8Array>> {
  return requestStream("/api/agent", body, signal);
}

/** Answers an approval card. The agent continues on the returned NDJSON event stream. */
export function submitApproval(body: ApprovalRequest, signal: AbortSignal): Promise<ReadableStream<Uint8Array>> {
  return requestStream("/api/agent/approve", body, signal);
}

// ── Workspace, git and checkpoints ──────────────────────────────────────────

/** The default workspace, so a new task can offer worktree isolation. */
export function fetchDefaultWorkspace(): Promise<DefaultWorkspaceView> {
  return requestJson("/api/workspace");
}

export function fetchChanges(conversationId: string): Promise<GitChanges> {
  return requestJson(`${conversationPath(conversationId)}/changes`);
}

/** Commit, push, open a pull request, merge or discard. The server answers 409 while the agent runs. */
export function runGitAction(conversationId: string, action: GitAction): Promise<GitActionResult> {
  return postJson(`${conversationPath(conversationId)}/git`, action);
}

export function restoreCheckpoint(
  conversationId: string,
  body: RestoreCheckpointRequest,
): Promise<RestoreCheckpointResult> {
  return postJson(`${conversationPath(conversationId)}/checkpoints`, body);
}

// ── MCP servers ─────────────────────────────────────────────────────────────

export type McpAction = z.infer<typeof mcpActionSchema>["action"];

export function updateMcpServer(name: string, action: McpAction): Promise<McpServerView> {
  return postJson(`/api/mcp/${encodeURIComponent(name)}`, { action });
}

// ── Access ──────────────────────────────────────────────────────────────────

export function fetchSession(): Promise<SessionView> {
  return requestJson("/api/auth/session");
}

/** Resolves when the token is accepted (the server sets the session cookie). 401: wrong token, 429: rate limited. */
export async function login(token: string): Promise<void> {
  await request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ token }),
    redirectOnUnauthorized: false,
  });
}

export async function logout(): Promise<void> {
  await request("/api/auth/logout", { method: "POST", redirectOnUnauthorized: false });
}
