import type { z } from "zod";

/** `auto` runs without asking, `ask` pauses for an approval card, `off` hides the tool from the model. */
export type ToolPolicy = "auto" | "ask" | "off";
export type ToolRisk = "read" | "write" | "network" | "execute";
export type ToolAvailability = { ok: true } | { ok: false; reason: string };

export type ToolContext = {
  signal: AbortSignal;
  conversationId: string;
  /** The running agent, for tools that orchestrate other agents (delegate_tasks). Absent in sub-agents. */
  runtime?: AgentRuntime;
};

/** What an orchestrating tool needs from the run that called it. Defined structurally to avoid import cycles. */
export type AgentRuntime = {
  provider: "ollama" | "gpu";
  model: string;
  permissionMode: "ask" | "accept_edits" | "plan" | "full_auto";
  messageId: string;
  callId: string;
  emit: (event: import("@/lib/contract").AgentEvent) => void;
  complete: import("../llm").CompletionFn;
  tools: ToolDefinition[];
  /** Runs one tool call with the same checkpointing and error handling as the main agent. */
  execute: (tool: ToolDefinition, input: unknown, signal: AbortSignal) => Promise<ToolOutput>;
  /** Effective policy for a tool under the current mode, settings and grants. */
  policyOf: (tool: ToolDefinition) => "auto" | "ask" | "off";
};

/** `content` goes back to the model verbatim, so keep it compact plain text or markdown. */
export type ToolOutput = { status: "ok" | "error"; content: string };

export type ToolDefinition<S extends z.ZodObject = z.ZodObject> = {
  /** Model-facing name matching `toolNamePattern`: lowercase letters, digits and underscores, at most 64 characters. */
  name: string;
  /** Short human label for the UI, for example "Search the web". */
  title: string;
  /** Model-facing description: what it does and when to use it. */
  description: string;
  /** Strict zod object. Its JSON schema is what the model sees, unless `parameters` is given. */
  schema: S;
  /** A ready-made JSON schema for the model (MCP tools); `schema` then only checks the shape loosely. */
  parameters?: Record<string, unknown>;
  /** Defaults to builtin. */
  source?: "builtin" | { mcpServer: string };
  defaultPolicy: ToolPolicy;
  risk: ToolRisk;
  /** Whether the tool is configured. Unavailable tools are never offered to the model. */
  available(): ToolAvailability;
  /** One line for the approval card, for example "Write 1.2 KB to notes/todo.md". */
  summarize(input: z.infer<S>): string;
  /** Must not throw for expected failures; return `{ status: "error" }` with a useful message. */
  run(input: z.infer<S>, ctx: ToolContext): Promise<ToolOutput>;
};

/** Upper bound for any tool result sent back to the model. */
export const MAX_TOOL_OUTPUT_CHARS = 20_000;

export function truncate(text: string, max = MAX_TOOL_OUTPUT_CHARS): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n\n[truncated ${text.length - max} characters]`;
}
