import { z } from "zod";
import { renameSchema } from "@/lib/contract";
import { conversationDetail, isRunning } from "@/lib/server/agent";
import { removeCheckpointStore } from "@/lib/server/checkpoints";
import { deleteConversation, getConversation, renameConversation } from "@/lib/server/db";
import { removeTaskWorktree } from "@/lib/server/git";
import { failure, guard, readJson } from "@/lib/server/http";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };
const idSchema = z.string().uuid();
const notFound = () => failure("This conversation no longer exists.", 404);
const noStore = { "Cache-Control": "no-store" };

export async function GET(request: Request, { params }: Context) {
  const denied = await guard(request);
  if (denied) return denied;
  const id = idSchema.safeParse((await params).id);
  const detail = id.success ? conversationDetail(id.data) : null;
  return detail ? Response.json(detail, { headers: noStore }) : notFound();
}

export async function PATCH(request: Request, { params }: Context) {
  const denied = await guard(request);
  if (denied) return denied;
  const id = idSchema.safeParse((await params).id);
  if (!id.success) return notFound();
  let body;
  try {
    body = renameSchema.safeParse(await readJson(request, 10_000));
  } catch {
    return failure("Send a title.", 400);
  }
  if (!body.success) return failure("Titles need 1 to 120 characters.", 400);
  const conversation = renameConversation(id.data, body.data.title);
  if (!conversation) return notFound();
  const { id: conversationId, title, createdAt, updatedAt } = conversation;
  return Response.json({ id: conversationId, title, createdAt, updatedAt }, { headers: noStore });
}

export async function DELETE(request: Request, { params }: Context) {
  const denied = await guard(request);
  if (denied) return denied;
  const id = idSchema.safeParse((await params).id);
  if (!id.success) return notFound();
  if (isRunning(id.data)) return failure("Stop this task before deleting it.", 409);
  const conversation = getConversation(id.data);
  if (!conversation) return notFound();
  // Remove the task's worktree and snapshot store first; both are best effort and never throw.
  await removeTaskWorktree(conversation);
  await removeCheckpointStore(conversation.id);
  deleteConversation(conversation.id);
  return new Response(null, { status: 204 });
}
