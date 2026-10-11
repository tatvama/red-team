import { z } from "zod";
import { gitActionSchema } from "@/lib/contract";
import { isRunning } from "@/lib/server/agent";
import { getConversation } from "@/lib/server/db";
import { GitError, runGitAction } from "@/lib/server/git";
import { failure, guard, readJson } from "@/lib/server/http";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };
const idSchema = z.string().uuid();
const notFound = () => failure("This conversation no longer exists.", 404);

/** Commit, push, open a pull request, merge or discard the task's work. */
export async function POST(request: Request, { params }: Context) {
  const denied = await guard(request);
  if (denied) return denied;
  const id = idSchema.safeParse((await params).id);
  const conversation = id.success ? getConversation(id.data) : null;
  if (!conversation) return notFound();
  let body;
  try {
    body = gitActionSchema.safeParse(await readJson(request, 40_000));
  } catch {
    return failure("Send a git action.", 400);
  }
  if (!body.success) return failure("Choose commit, push, pull_request, merge or discard, with the fields it needs.", 400);
  // Opening a pull request pushes too, so every action waits for the agent to stop.
  if (isRunning(conversation.id)) return failure("Wait for the task to finish, or stop it, before using git.", 409);
  try {
    return Response.json(await runGitAction(conversation, body.data), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof GitError) return failure(error.message, error.status);
    return failure("The git action failed unexpectedly.", 500);
  }
}
