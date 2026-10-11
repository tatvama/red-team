import { z } from "zod";
import { feedbackSchema } from "@/lib/contract";
import * as db from "@/lib/server/db";
import { failure, guard, readJson } from "@/lib/server/http";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

// Feedback is stored only for an assistant reply (or one of its tool calls) in this conversation.
export async function PUT(request: Request, { params }: Context) {
  const denied = await guard(request);
  if (denied) return denied;
  const id = z.string().uuid().safeParse((await params).id);
  if (!id.success || !db.getConversation(id.data)) return failure("This conversation no longer exists.", 404);
  let parsed;
  try {
    parsed = feedbackSchema.safeParse(await readJson(request, 120_000));
  } catch {
    return failure("This feedback could not be read.", 400);
  }
  if (!parsed.success) return failure("This feedback is not valid.", 400);
  const input = parsed.data;
  const message = db.listMessages(id.data).find((item) => item.id === input.messageId);
  if (!message || message.role !== "assistant") return failure("You can only rate the agent's replies in this conversation.", 400);
  if (input.toolCallId && !message.toolCalls.some((call) => call.id === input.toolCallId))
    return failure("That tool call is not part of this reply.", 400);
  db.saveFeedback(id.data, input);
  return Response.json({ feedback: db.listFeedback(id.data) }, { headers: { "Cache-Control": "no-store" } });
}
