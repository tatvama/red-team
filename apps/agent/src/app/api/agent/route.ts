import { agentRequestSchema } from "@/lib/contract";
import { finishRun, runAgent, skipPendingCalls, titleFrom, tryStartRun, worktreeMissing } from "@/lib/server/agent";
import { createCheckpoint } from "@/lib/server/checkpoints";
import { defaultWorkspaceDir } from "@/lib/server/config";
import * as db from "@/lib/server/db";
import { GitError, createTaskWorktree, sharedBaseline } from "@/lib/server/git";
import { failure, guard, ndjsonResponse, readJson } from "@/lib/server/http";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const denied = await guard(request);
  if (denied) return denied;
  let parsed;
  try {
    parsed = agentRequestSchema.safeParse(await readJson(request));
  } catch {
    return failure("This message is too large or could not be read.", 400);
  }
  if (!parsed.success) return failure("Check your message and model, then try again.", 400);
  const { conversationId, content, provider, model, permissionMode, isolation } = parsed.data;

  let conversation = conversationId ? db.getConversation(conversationId) : null;
  if (conversationId && !conversation) return failure("This conversation no longer exists.", 404);
  const isNew = !conversation;
  if (!conversation) {
    const title = titleFrom(content ?? "");
    const created = db.createConversation({ title, provider, model, permissionMode });
    try {
      if (isolation === "worktree") {
        const worktree = await createTaskWorktree(created.id, title);
        db.setConversationWorkspace(created.id, { mode: "worktree", ...worktree });
      } else {
        const baseline = await sharedBaseline(defaultWorkspaceDir());
        if (baseline)
          db.setConversationWorkspace(created.id, {
            mode: "shared",
            path: null,
            branch: baseline.branch,
            baseBranch: baseline.branch,
            baseCommit: baseline.baseCommit,
          });
      }
    } catch (error) {
      db.deleteConversation(created.id);
      return failure(error instanceof GitError ? error.message : "Could not prepare the workspace for this task.", 400);
    }
    conversation = db.getConversation(created.id)!;
  }

  const id = conversation.id;
  if (worktreeMissing(conversation))
    return failure("This task's worktree was discarded. Start a new task to keep working.", 409);
  if (!tryStartRun(id)) return failure("This task is already running. Stop it or wait for it to finish.", 409);
  db.updateConversationRun(id, { provider, model, permissionMode });
  const { title, createdAt, updatedAt } = conversation;
  const workspace = conversation.workspacePath ?? defaultWorkspaceDir();

  return ndjsonResponse(
    request,
    async (emit, signal) => {
      if (isNew) emit({ type: "conversation", conversation: { id, title, createdAt, updatedAt } });
      if (content) {
        skipPendingCalls(id);
        const message = db.appendMessage(id, { role: "user", content });
        emit({ type: "message", message: { id: message.id, role: "user", content, createdAt: message.createdAt } });
        // A turn checkpoint lets the user rewind files and conversation to just before this message.
        const checkpoint = await createCheckpoint({
          conversationId: id,
          workspace,
          kind: "turn",
          label: `Before: ${titleFrom(content)}`,
          messageId: message.id,
          messageSeq: message.seq,
        });
        if (checkpoint) emit({ type: "checkpoint", checkpoint });
      }
      await runAgent({ conversationId: id, provider, model, permissionMode, signal, emit });
    },
    () => finishRun(id),
  );
}
