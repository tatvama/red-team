import { z } from "zod";
import { getConversation } from "@/lib/server/db";
import { getChanges } from "@/lib/server/git";
import { failure, guard } from "@/lib/server/http";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };
const idSchema = z.string().uuid();
const notFound = () => failure("This conversation no longer exists.", 404);

/** Everything the task changed since it started, for the review panel. */
export async function GET(request: Request, { params }: Context) {
  const denied = await guard(request);
  if (denied) return denied;
  const id = idSchema.safeParse((await params).id);
  const conversation = id.success ? getConversation(id.data) : null;
  if (!conversation) return notFound();
  try {
    return Response.json(await getChanges(conversation), { headers: { "Cache-Control": "no-store" } });
  } catch {
    return failure("Could not read the task's changes.", 500);
  }
}
