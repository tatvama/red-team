import { z } from "zod";
import { failure, guard } from "@/lib/server/http";
import { getDistillJob } from "@/lib/server/training/distill";

export const runtime = "nodejs";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await guard(request);
  if (denied) return denied;
  const id = z.string().uuid().safeParse((await params).id);
  const job = id.success ? getDistillJob(id.data) : null;
  if (!job) return failure("This distillation job no longer exists.", 404);
  return Response.json(job, { headers: { "Cache-Control": "no-store" } });
}
