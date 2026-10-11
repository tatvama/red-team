import { evalRunRequestSchema } from "@/lib/contract";
import { failure, guard, readJson } from "@/lib/server/http";
import { EvalRequestError, listEvalRuns, startEvalRun } from "@/lib/server/training/evals/runner";

export const runtime = "nodejs";
const noStore = { "Cache-Control": "no-store" };

export async function GET(request: Request) {
  const denied = await guard(request);
  if (denied) return denied;
  return Response.json({ runs: listEvalRuns() }, { headers: noStore });
}

export async function POST(request: Request) {
  const denied = await guard(request);
  if (denied) return denied;
  let parsed;
  try {
    parsed = evalRunRequestSchema.safeParse(await readJson(request, 20_000));
  } catch {
    return failure("This evaluation request could not be read.", 400);
  }
  if (!parsed.success) return failure("Choose a suite and a target model, then try again.", 400);
  try {
    return Response.json(startEvalRun(parsed.data), { headers: noStore });
  } catch (error) {
    if (error instanceof EvalRequestError) return failure(error.message, 400);
    throw error;
  }
}
