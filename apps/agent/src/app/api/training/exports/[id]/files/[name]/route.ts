import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { z } from "zod";
import { failure, guard } from "@/lib/server/http";
import { exportFile } from "@/lib/server/training/dataset";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string; name: string }> };
const idSchema = z.string().uuid();
const notFound = () => failure("This file is not part of the export.", 404);

/** Downloads one file of an export. Only names in the export's recorded file list are served. */
export async function GET(request: Request, { params }: Context) {
  const denied = await guard(request);
  if (denied) return denied;
  const { id, name } = await params;
  const parsedId = idSchema.safeParse(id);
  if (!parsedId.success || typeof name !== "string") return notFound();
  const file = exportFile(parsedId.data, name);
  if (!file) return notFound();
  let size: number;
  try {
    const info = await stat(file.path);
    if (!info.isFile()) return notFound();
    size = info.size;
  } catch {
    return notFound();
  }
  const body = Readable.toWeb(createReadStream(file.path)) as unknown as ReadableStream<Uint8Array>;
  return new Response(body, {
    headers: {
      "Content-Type": file.contentType,
      "Content-Length": String(size),
      "Content-Disposition": `attachment; filename="${file.name}"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
