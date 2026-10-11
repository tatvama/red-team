import { datasetExportRequestSchema } from "@/lib/contract";
import { failure, guard, readJson } from "@/lib/server/http";
import { createDatasetExport, DatasetExportError, listDatasetExports } from "@/lib/server/training/dataset";

export const runtime = "nodejs";
const noStore = { "Cache-Control": "no-store" };

export async function GET(request: Request) {
  const denied = await guard(request);
  if (denied) return denied;
  return Response.json({ exports: listDatasetExports() }, { headers: noStore });
}

export async function POST(request: Request) {
  const denied = await guard(request);
  if (denied) return denied;
  let parsed;
  try {
    parsed = datasetExportRequestSchema.safeParse(await readJson(request, 10_000));
  } catch {
    return failure("This export request could not be read.", 400);
  }
  if (!parsed.success) return failure("Check the export options and try again.", 400);
  try {
    return Response.json(await createDatasetExport(parsed.data), { status: 201, headers: noStore });
  } catch (error) {
    if (error instanceof DatasetExportError) return failure(error.message, error.status);
    return failure("The dataset could not be written. Check the server logs and the free disk space.", 500);
  }
}
