import { z } from "zod";
import { trainingStatusUpdateSchema } from "@/lib/contract";
import * as db from "@/lib/server/db";
import { failure, guard, readJson } from "@/lib/server/http";

export const runtime = "nodejs";

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await guard(request);
  if (denied) return denied;
  const id = z.string().uuid().safeParse((await params).id);
  if (!id.success) return failure("This conversation no longer exists.", 404);
  let parsed;
  try {
    parsed = trainingStatusUpdateSchema.safeParse(await readJson(request, 1_000));
  } catch {
    return failure("Send a training status.", 400);
  }
  if (!parsed.success) return failure("Choose unreviewed, approved or excluded.", 400);
  if (!db.setTrainingStatus(id.data, parsed.data.trainingStatus)) return failure("This conversation no longer exists.", 404);
  return Response.json({ trainingStatus: parsed.data.trainingStatus }, { headers: { "Cache-Control": "no-store" } });
}
