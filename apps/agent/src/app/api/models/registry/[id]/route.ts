import { z } from "zod";
import { updateModelSchema } from "@/lib/contract";
import { failure, guard, readJson } from "@/lib/server/http";
import { deleteModel, RegistryError, updateModel } from "@/lib/server/training/registry";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };
const idSchema = z.string().uuid();
const notFound = () => failure("This model is not registered.", 404);
const noStore = { "Cache-Control": "no-store" };

export async function PATCH(request: Request, { params }: Context) {
  const denied = await guard(request);
  if (denied) return denied;
  const id = idSchema.safeParse((await params).id);
  if (!id.success) return notFound();
  let parsed;
  try {
    parsed = updateModelSchema.safeParse(await readJson(request, 20_000));
  } catch {
    return failure("These changes could not be read.", 400);
  }
  if (!parsed.success) return failure("Check the model details and try again.", 400);
  try {
    return Response.json(updateModel(id.data, parsed.data), { headers: noStore });
  } catch (error) {
    if (error instanceof RegistryError) return failure(error.message, error.status);
    throw error;
  }
}

export async function DELETE(request: Request, { params }: Context) {
  const denied = await guard(request);
  if (denied) return denied;
  const id = idSchema.safeParse((await params).id);
  if (!id.success || !deleteModel(id.data)) return notFound();
  return new Response(null, { status: 204 });
}
