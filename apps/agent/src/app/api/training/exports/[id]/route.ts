import { z } from "zod";
import { failure, guard } from "@/lib/server/http";
import { deleteDatasetExport, getDatasetExport } from "@/lib/server/training/dataset";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };
const idSchema = z.string().uuid();
const notFound = () => failure("This export no longer exists.", 404);

export async function GET(request: Request, { params }: Context) {
  const denied = await guard(request);
  if (denied) return denied;
  const id = idSchema.safeParse((await params).id);
  const view = id.success ? getDatasetExport(id.data) : null;
  return view ? Response.json(view, { headers: { "Cache-Control": "no-store" } }) : notFound();
}

export async function DELETE(request: Request, { params }: Context) {
  const denied = await guard(request);
  if (denied) return denied;
  const id = idSchema.safeParse((await params).id);
  if (!id.success) return notFound();
  try {
    if (!(await deleteDatasetExport(id.data))) return notFound();
  } catch {
    return failure("The export folder could not be removed. Close any program using it and try again.", 500);
  }
  return new Response(null, { status: 204 });
}
