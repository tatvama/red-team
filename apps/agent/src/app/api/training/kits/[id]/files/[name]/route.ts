import { createReadStream } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { z } from "zod";
import { failure, guard } from "@/lib/server/http";
import { kitFile } from "@/lib/server/training/kits";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string; name: string }> };
const idSchema = z.string().uuid();
const notFound = () => failure("This file is not part of the kit.", 404);

const CONTENT_TYPES: Record<string, string> = {
  ".md": "text/markdown; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jsonl": "application/x-ndjson; charset=utf-8",
  ".py": "text/x-python; charset=utf-8",
  ".sh": "text/x-shellscript; charset=utf-8",
  ".yaml": "application/yaml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

/** The name as sent and, when it differs, percent-decoded ("data%2Fsft_train.jsonl"). Both must match a recorded name. */
function candidates(name: string): string[] {
  try {
    const decoded = decodeURIComponent(name);
    return decoded === name ? [name] : [name, decoded];
  } catch {
    return [name];
  }
}

/** Downloads one file of a kit. Only names in the kit's recorded file list are served. */
export async function GET(request: Request, { params }: Context) {
  const denied = await guard(request);
  if (denied) return denied;
  const { id, name } = await params;
  const kitId = idSchema.safeParse(id);
  if (!kitId.success || typeof name !== "string") return notFound();
  const file = candidates(name)
    .map((candidate) => kitFile(kitId.data, candidate))
    .find((match) => match !== null);
  if (!file) return notFound();
  const body = Readable.toWeb(createReadStream(file.path)) as unknown as ReadableStream<Uint8Array>;
  return new Response(body, {
    headers: {
      "Content-Type": CONTENT_TYPES[path.extname(file.name)] ?? "application/octet-stream",
      "Content-Length": String(file.bytes),
      "Content-Disposition": `attachment; filename="${path.posix.basename(file.name)}"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
