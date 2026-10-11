import { providerSchema } from "@/lib/contract";
import { failure, guard } from "@/lib/server/http";
import { modelConnection } from "@/lib/server/llm";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const denied = await guard(request);
  if (denied) return denied;
  const provider = providerSchema.safeParse(new URL(request.url).searchParams.get("provider"));
  if (!provider.success) return failure("Choose a supported model connection.", 400);
  const connection = await modelConnection(provider.data, request.signal);
  return Response.json(connection, { headers: { "Cache-Control": "no-store" } });
}
