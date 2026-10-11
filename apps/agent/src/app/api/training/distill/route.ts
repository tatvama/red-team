import { distillRequestSchema } from "@/lib/contract";
import { failure, guard, readJson } from "@/lib/server/http";
import { DistillRequestError, listDistillJobs, startDistillJob } from "@/lib/server/training/distill";

export const runtime = "nodejs";
const noStore = { "Cache-Control": "no-store" };

export async function GET(request: Request) {
  const denied = await guard(request);
  if (denied) return denied;
  return Response.json({ jobs: listDistillJobs() }, { headers: noStore });
}

export async function POST(request: Request) {
  const denied = await guard(request);
  if (denied) return denied;
  let parsed;
  try {
    // Up to 200 prompts of 8,000 characters each.
    parsed = distillRequestSchema.safeParse(await readJson(request, 2_000_000));
  } catch {
    return failure("This distillation request could not be read.", 400);
  }
  if (!parsed.success) return failure("Choose a teacher model and the prompts to distill, then try again.", 400);
  try {
    return Response.json(startDistillJob(parsed.data), { headers: noStore });
  } catch (error) {
    if (error instanceof DistillRequestError) return failure(error.message, 400);
    throw error;
  }
}
