import { mcpActionSchema } from "@/lib/contract";
import { failure, guard, readJson } from "@/lib/server/http";
import { serverNamePattern } from "@/lib/server/mcp/config";
import { restartMcpServer, setMcpServerEnabled } from "@/lib/server/mcp/manager";

export const runtime = "nodejs";
const noStore = { "Cache-Control": "no-store" };

/** Enable, disable or restart a server from the MCP config. Servers cannot be added here. */
export async function POST(request: Request, { params }: { params: Promise<{ name: string }> }) {
  const denied = await guard(request);
  if (denied) return denied;
  let parsed;
  try {
    parsed = mcpActionSchema.safeParse(await readJson(request, 10_000));
  } catch {
    return failure("This request could not be read.", 400);
  }
  if (!parsed.success) return failure("Choose enable, disable or restart.", 400);

  const { name } = await params;
  if (!serverNamePattern.test(name)) return failure("That MCP server is not configured.", 404);
  const { action } = parsed.data;
  const view = action === "restart" ? await restartMcpServer(name) : await setMcpServerEnabled(name, action === "enable");
  if (!view) return failure("That MCP server is not configured.", 404);
  if (action === "enable" && !view.enabled)
    return failure("This server is disabled in the MCP config file. Edit the file to enable it.", 409);
  return Response.json(view, { headers: noStore });
}
