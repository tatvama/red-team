import { finetuneKitRequestSchema } from "@/lib/contract";
import { failure, guard, readJson } from "@/lib/server/http";
import { createKit, KitError, listKits } from "@/lib/server/training/kits";

export const runtime = "nodejs";
const noStore = { "Cache-Control": "no-store" };

export async function GET(request: Request) {
  const denied = await guard(request);
  if (denied) return denied;
  return Response.json({ kits: listKits() }, { headers: noStore });
}

export async function POST(request: Request) {
  const denied = await guard(request);
  if (denied) return denied;
  let parsed;
  try {
    parsed = finetuneKitRequestSchema.safeParse(await readJson(request, 10_000));
  } catch {
    return failure("This kit request could not be read.", 400);
  }
  if (!parsed.success) return failure("Check the kit options and try again.", 400);
  try {
    return Response.json(await createKit(parsed.data), { status: 201, headers: noStore });
  } catch (error) {
    if (error instanceof KitError) return failure(error.message, error.status);
    return failure("The kit could not be written. Check the server logs and the free disk space.", 500);
  }
}
