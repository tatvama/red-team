import { conversationKindSchema, trainingStatusSchema } from "@/lib/contract";
import { failure, guard } from "@/lib/server/http";
import { listReviewQueue } from "@/lib/server/training/review";

export const runtime = "nodejs";

/** GET /api/training/conversations?status=&kind= — the review queue, newest first, at most 500. */
export async function GET(request: Request) {
  const denied = await guard(request);
  if (denied) return denied;
  const query = new URL(request.url).searchParams;
  const status = query.get("status") || undefined;
  const kind = query.get("kind") || undefined;
  const parsedStatus = trainingStatusSchema.optional().safeParse(status);
  if (!parsedStatus.success) return failure("Filter by status unreviewed, approved or excluded.", 400);
  const parsedKind = conversationKindSchema.optional().safeParse(kind);
  if (!parsedKind.success) return failure("Filter by kind chat, eval or distill.", 400);
  const conversations = listReviewQueue({ status: parsedStatus.data, kind: parsedKind.data });
  return Response.json({ conversations }, { headers: { "Cache-Control": "no-store" } });
}
