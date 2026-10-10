import "server-only";
import { z } from "zod";
import { planItemSchema } from "@/lib/contract";
import { setPlan } from "../db";
import type { ToolDefinition } from "./types";

const schema = z
  .object({
    plan: z
      .array(planItemSchema)
      .min(1)
      .max(30)
      .describe("The full, updated list of steps. Keep exactly one step in_progress while working."),
  })
  .strict();

export const updatePlanTool: ToolDefinition<typeof schema> = {
  name: "update_plan",
  title: "Update plan",
  description:
    "Create or update the visible task plan for multi-step work. Send the complete list each time, " +
    "mark the current step in_progress and finished steps completed. Skip this for simple one-step requests.",
  schema,
  defaultPolicy: "auto",
  risk: "read",
  available: () => ({ ok: true }),
  summarize: (input) => {
    const done = input.plan.filter((item) => item.status === "completed").length;
    return `Plan: ${done} of ${input.plan.length} steps done`;
  },
  async run(input, ctx) {
    if (input.plan.filter((item) => item.status === "in_progress").length > 1)
      return { status: "error", content: "Only one step can be in_progress at a time." };
    setPlan(ctx.conversationId, input.plan);
    const done = input.plan.filter((item) => item.status === "completed").length;
    return { status: "ok", content: `Plan updated: ${done} of ${input.plan.length} steps completed.` };
  },
};
