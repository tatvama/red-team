/**
 * Reads a newline-delimited JSON stream and yields one parsed value per line.
 *
 * Lines can be split across chunks at any byte, including inside a multi-byte UTF-8 character.
 * Blank and malformed lines are skipped. A final line without a trailing newline is yielded when it
 * parses; a truncated one (for example after an abort) is dropped.
 */
export async function* readNdjson(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown, void, undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const parsed = parseLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        if (parsed.ok) yield parsed.value;
        newline = buffer.indexOf("\n");
      }
    }
    buffer += decoder.decode();
    const last = parseLine(buffer);
    if (last.ok) yield last.value;
  } finally {
    reader.releaseLock();
  }
}

function parseLine(line: string): { ok: true; value: unknown } | { ok: false } {
  const text = line.trim();
  if (!text) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}
