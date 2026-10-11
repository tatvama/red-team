import "server-only";
import { z } from "zod";
import { addMemory, deleteMemory, listMemories } from "../db";
import type { ToolDefinition } from "./types";

const MAX_MEMORIES = 100;

const saveSchema = z
  .object({
    text: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .describe("One durable fact or preference, written in the third person, e.g. 'Prefers TypeScript over JavaScript'."),
  })
  .strict();

export const saveMemoryTool: ToolDefinition<typeof saveSchema> = {
  name: "save_memory",
  title: "Remember",
  description:
    "Save a durable fact about the user or their projects that will help in future conversations " +
    "(preferences, names, recurring context). Do not save secrets, passwords, keys or one-off details. " +
    "Saved memories appear in your instructions in every conversation.",
  schema: saveSchema,
  defaultPolicy: "auto",
  risk: "write",
  available: () => ({ ok: true }),
  summarize: (input) => `Remember: ${input.text.slice(0, 80)}`,
  async run(input) {
    if (/(api[_-]?key|password|secret|token)\s*[:=]/i.test(input.text))
      return { status: "error", content: "Memories must not contain secrets or credentials." };
    if (listMemories().length >= MAX_MEMORIES)
      return { status: "error", content: `Memory is full (${MAX_MEMORIES} items). Ask the user to remove some in Settings.` };
    const memory = addMemory(input.text);
    return { status: "ok", content: `Saved memory ${memory.id}.` };
  },
};

const forgetSchema = z.object({ id: z.string().uuid().describe("The memory id shown in your instructions.") }).strict();

export const forgetMemoryTool: ToolDefinition<typeof forgetSchema> = {
  name: "forget_memory",
  title: "Forget",
  description: "Delete a saved memory that is wrong or that the user asked you to forget.",
  schema: forgetSchema,
  defaultPolicy: "auto",
  risk: "write",
  available: () => ({ ok: true }),
  summarize: () => "Forget a saved memory",
  async run(input) {
    return deleteMemory(input.id)
      ? { status: "ok", content: "Memory deleted." }
      : { status: "error", content: "No memory with that id." };
  },
};
