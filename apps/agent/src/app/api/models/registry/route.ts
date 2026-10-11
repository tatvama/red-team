import { registerModelSchema } from "@/lib/contract";
import { failure, guard, readJson } from "@/lib/server/http";
import { listModels, registerModel, RegistryError } from "@/lib/server/training/registry";

export const runtime = "nodejs";
const noStore = { "Cache-Control": "no-store" };

export async function GET(request: Request) {
  const denied = await guard(request);
  if (denied) return denied;
  return Response.json({ models: listModels() }, { headers: noStore });
}

export async function POST(request: Request) {
  const denied = await guard(request);
  if (denied) return denied;
  let parsed;
  try {
    parsed = registerModelSchema.safeParse(await readJson(request, 20_000));
  } catch {
    return failure("This model could not be read.", 400);
  }
  if (!parsed.success) return failure("Check the model details and try again.", 400);
  try {
    return Response.json(registerModel(parsed.data), { status: 201, headers: noStore });
  } catch (error) {
    if (error instanceof RegistryError) return failure(error.message, error.status);
    throw error;
  }
}
