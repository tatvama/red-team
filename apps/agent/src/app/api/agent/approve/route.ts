import { approvalRequestSchema } from "@/lib/contract";
import { finishRun, runAgent, tryStartRun, unresolvedCalls, worktreeMissing } from "@/lib/server/agent";
import * as db from "@/lib/server/db";
import { failure, guard, ndjsonResponse, readJson } from "@/lib/server/http";
import { chooseModel, getRouterConfig } from "@/lib/server/router";

export const runtime = "nodejs";

// Approvals are recorded only for a call that is still pending in this conversation, and only from
// an authorized same-origin request. Model output can never reach this endpoint.
export async function POST(request: Request) {
  const denied = await guard(request);
  if (denied) return denied;
  let parsed;
  try {
    parsed = approvalRequestSchema.safeParse(await readJson(request, 10_000));
  } catch {
    return failure("This approval could not be read.", 400);
  }
  if (!parsed.success) return failure("This approval is not valid.", 400);
  const { conversationId: id, callId, decision, permissionMode, useRouter } = parsed.data;

  const conversation = db.getConversation(id);
  if (!conversation) return failure("This conversation no longer exists.", 404);
  const existing =
    useRouter && conversation.provider && conversation.model ? { provider: conversation.provider, model: conversation.model } : null;
  const { provider, model } = chooseModel(getRouterConfig(), {
    requested: { provider: parsed.data.provider, model: parsed.data.model },
    existing,
    useRouter: useRouter ?? false,
  });
  if (worktreeMissing(conversation))
    return failure("This task's worktree was discarded. Start a new task to keep working.", 409);
  if (!tryStartRun(id)) return failure("This task is already running.", 409);
  const call = unresolvedCalls(db.listMessages(id)).find((item) => item.id === callId);
  if (!call) {
    finishRun(id);
    return failure("This approval is no longer pending.", 409);
  }
  db.updateConversationRun(id, { provider, model, permissionMode });
  db.recordApproval(id, callId, decision === "deny" ? "deny" : "approve");
  if (decision === "approve_always") db.allowTool(id, call.name);

  return ndjsonResponse(
    request,
    (emit, signal) => runAgent({ conversationId: id, provider, model, permissionMode, signal, emit }),
    () => finishRun(id),
  );
}
