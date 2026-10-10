import { listConversations } from "@/lib/server/db";
import { guard } from "@/lib/server/http";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const denied = await guard(request);
  if (denied) return denied;
  return Response.json({ conversations: listConversations() }, { headers: { "Cache-Control": "no-store" } });
}
