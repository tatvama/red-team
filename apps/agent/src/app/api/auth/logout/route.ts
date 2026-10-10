import { clearedSessionCookie } from "@/lib/server/auth";
import { guard } from "@/lib/server/http";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const denied = await guard(request, "optional");
  if (denied) return denied;
  return new Response(null, {
    status: 204,
    headers: { "Set-Cookie": clearedSessionCookie(request), "Cache-Control": "no-store" },
  });
}
