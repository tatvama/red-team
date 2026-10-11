import { defaultWorkspaceDir } from "@/lib/server/config";
import { inspectWorkspace } from "@/lib/server/git";
import { guard } from "@/lib/server/http";

export const runtime = "nodejs";

/** The default workspace, so the composer can offer worktree isolation when it is a git repository. */
export async function GET(request: Request) {
  const denied = await guard(request);
  if (denied) return denied;
  return Response.json(await inspectWorkspace(defaultWorkspaceDir()), { headers: { "Cache-Control": "no-store" } });
}
