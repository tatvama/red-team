import { z } from "zod";
import { failure, guard } from "@/lib/server/http";
import { getEvalRun } from "@/lib/server/training/evals/runner";

export const runtime = "nodejs";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await guard(request);
  if (denied) return denied;
  const id = z.string().uuid().safeParse((await params).id);
  const run = id.success ? getEvalRun(id.data) : null;
  if (!run) return failure("This evaluation run no longer exists.", 404);
  return Response.json(run, { headers: { "Cache-Control": "no-store" } });
}
