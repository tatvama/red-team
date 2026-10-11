import { guard } from "@/lib/server/http";
import { listSuites, suiteView } from "@/lib/server/training/evals/suite";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const denied = await guard(request);
  if (denied) return denied;
  return Response.json({ suites: listSuites().map(suiteView) }, { headers: { "Cache-Control": "no-store" } });
}
