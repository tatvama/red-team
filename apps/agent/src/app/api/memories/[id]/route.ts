import { z } from "zod";
import { deleteMemory } from "@/lib/server/db";
import { failure, guard } from "@/lib/server/http";

export const runtime = "nodejs";

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await guard(request);
  if (denied) return denied;
  const id = z.string().uuid().safeParse((await params).id);
  if (!id.success || !deleteMemory(id.data)) return failure("That memory no longer exists.", 404);
  return new Response(null, { status: 204 });
}
