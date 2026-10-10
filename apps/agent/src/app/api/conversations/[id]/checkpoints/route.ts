import { z } from "zod";
import { restoreCheckpointSchema } from "@/lib/contract";
import { isRunning } from "@/lib/server/agent";
import { CheckpointError, restoreCheckpoint } from "@/lib/server/checkpoints";
import { getConversation } from "@/lib/server/db";
import { failure, guard, readJson } from "@/lib/server/http";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };
const idSchema = z.string().uuid();
const notFound = () => failure("This conversation no longer exists.", 404);

/** Restores the workspace files to a checkpoint, optionally rewinding the conversation too. */
export async function POST(request: Request, { params }: Context) {
  const denied = await guard(request);
  if (denied) return denied;
  const id = idSchema.safeParse((await params).id);
  const conversation = id.success ? getConversation(id.data) : null;
  if (!conversation) return notFound();
  let body;
  try {
    body = restoreCheckpointSchema.safeParse(await readJson(request, 10_000));
  } catch {
    return failure("Send a checkpoint to restore.", 400);
  }
  if (!body.success) return failure("Send a checkpointId and rewindConversation.", 400);
  if (isRunning(conversation.id)) return failure("Stop this task before restoring a checkpoint.", 409);
  try {
    return Response.json(await restoreCheckpoint(conversation, body.data), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof CheckpointError) return failure(error.message, error.status);
    return failure("Restoring the checkpoint failed unexpectedly.", 500);
  }
}
