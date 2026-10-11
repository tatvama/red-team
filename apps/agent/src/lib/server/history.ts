import "server-only";
import { z } from "zod";
import type { WireMessage, WireTool } from "./llm";
import type { ToolDefinition } from "./tools/types";

// Shared by the main agent loop and sub-agents.

export function wireTools(tools: ToolDefinition[]): WireTool[] {
  return tools.map((tool) => {
    // "input" keeps fields with defaults optional, which is what the model is allowed to send.
    const parameters = { ...(tool.parameters ?? (z.toJSONSchema(tool.schema, { io: "input" }) as Record<string, unknown>)) };
    delete parameters.$schema;
    return { type: "function", function: { name: tool.name, description: tool.description, parameters } };
  });
}

const OMITTED = "[Earlier tool output omitted to save context. Run the tool again if you need it.]";

/**
 * Keeps the history under a character budget: first elides older tool output, then drops the
 * oldest whole turns (a user message and everything up to the next one). The latest turn is kept.
 */
export function fitToBudget(history: WireMessage[], budgetChars: number): { messages: WireMessage[]; trimmed: boolean } {
  const size = (message: WireMessage) => JSON.stringify(message).length;
  let total = history.reduce((sum, message) => sum + size(message), 0);
  if (total <= budgetChars) return { messages: history, trimmed: false };
  const messages = history.map((message) => ({ ...message }));
  for (let index = 0; index < messages.length - 4 && total > budgetChars; index++) {
    const message = messages[index];
    if (message.role !== "tool" || message.content.length <= OMITTED.length) continue;
    total -= size(message);
    message.content = OMITTED;
    total += size(message);
  }
  let trimmed = false;
  while (total > budgetChars) {
    const next = messages.findIndex((message, index) => index > 0 && message.role === "user");
    if (next === -1) break;
    for (const message of messages.splice(0, next)) total -= size(message);
    trimmed = true;
  }
  return { messages, trimmed };
}

export function parseArgs(raw: string): unknown {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return undefined;
  }
}

/** A tool's one-line summary for these arguments, falling back to its title. */
export function summarizeCall(tool: ToolDefinition, input: unknown): string {
  const parsed = tool.schema.safeParse(input);
  if (!parsed.success) return tool.title;
  try {
    return tool.summarize(parsed.data);
  } catch {
    return tool.title;
  }
}
