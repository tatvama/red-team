import { settingsUpdateSchema } from "@/lib/contract";
import { failure, guard, readJson } from "@/lib/server/http";
import { settingsView, updateSettings } from "@/lib/server/settings";

export const runtime = "nodejs";
const noStore = { "Cache-Control": "no-store" };

export async function GET(request: Request) {
  const denied = await guard(request);
  if (denied) return denied;
  return Response.json(settingsView(), { headers: noStore });
}

export async function PUT(request: Request) {
  const denied = await guard(request);
  if (denied) return denied;
  let parsed;
  try {
    parsed = settingsUpdateSchema.safeParse(await readJson(request, 50_000));
  } catch {
    return failure("These settings could not be read.", 400);
  }
  if (!parsed.success) return failure("Check your settings and try again.", 400);
  return Response.json(updateSettings(parsed.data), { headers: noStore });
}
