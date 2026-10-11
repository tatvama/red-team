import type { SessionView } from "@/lib/contract";
import { decideAccess } from "@/lib/server/auth";
import { failure } from "@/lib/server/http";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const decision = await decideAccess(request, "optional");
  if (!decision.allowed) return failure("This address is not allowed to use Tatvam.", 403);
  const view: SessionView = { remote: decision.remote, authenticated: decision.authenticated };
  return Response.json(view, { headers: { "Cache-Control": "no-store" } });
}
