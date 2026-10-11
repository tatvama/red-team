import { routerConfigSchema } from "@/lib/contract";
import { failure, guard, readJson } from "@/lib/server/http";
import { getRouterConfig, saveRouterConfig } from "@/lib/server/router";

export const runtime = "nodejs";
const noStore = { "Cache-Control": "no-store" };

export async function GET(request: Request) {
  const denied = await guard(request);
  if (denied) return denied;
  return Response.json(getRouterConfig(), { headers: noStore });
}

export async function PUT(request: Request) {
  const denied = await guard(request);
  if (denied) return denied;
  let parsed;
  try {
    parsed = routerConfigSchema.safeParse(await readJson(request, 10_000));
  } catch {
    return failure("These router settings could not be read.", 400);
  }
  if (!parsed.success) return failure("Check the router settings and try again.", 400);
  if (parsed.data.enabled && !parsed.data.main) return failure("Choose a main model before turning the router on.", 400);
  return Response.json(saveRouterConfig(parsed.data), { headers: noStore });
}
