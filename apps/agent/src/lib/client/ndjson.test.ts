import { describe, expect, it } from "vitest";
import { readNdjson } from "./ndjson";

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

const encode = (text: string) => new TextEncoder().encode(text);

async function collect(stream: ReadableStream<Uint8Array>): Promise<unknown[]> {
  const values: unknown[] = [];
  for await (const value of readNdjson(stream)) values.push(value);
  return values;
}

describe("readNdjson", () => {
  it("yields several events from a single chunk", async () => {
    const values = await collect(streamOf([encode('{"a":1}\n{"b":2}\n{"c":3}\n')]));
    expect(values).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
  });

  it("joins a line split across chunks mid-line", async () => {
    const values = await collect(streamOf([encode('{"type":"tok'), encode('en","text":"hi"}\n{"n"'), encode(":2}\n")]));
    expect(values).toEqual([{ type: "token", text: "hi" }, { n: 2 }]);
  });

  it("decodes a multi-byte UTF-8 character split across chunks", async () => {
    const bytes = encode('{"text":"नमस्ते 🙂"}\n');
    const emojiStart = bytes.indexOf(0xf0);
    const chunks = [bytes.slice(0, 11), bytes.slice(11, emojiStart + 2), bytes.slice(emojiStart + 2)];
    expect(await collect(streamOf(chunks))).toEqual([{ text: "नमस्ते 🙂" }]);
  });

  it("splits every byte into its own chunk without losing data", async () => {
    const bytes = encode('{"text":"é"}\n{"ok":true}\n');
    const chunks = Array.from(bytes, (byte) => Uint8Array.of(byte));
    expect(await collect(streamOf(chunks))).toEqual([{ text: "é" }, { ok: true }]);
  });

  it("parses a complete trailing line without a newline", async () => {
    expect(await collect(streamOf([encode('{"a":1}\n{"b":2}')]))).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("drops a truncated trailing line", async () => {
    expect(await collect(streamOf([encode('{"a":1}\n{"type":"tok')]))).toEqual([{ a: 1 }]);
  });

  it("skips blank lines, CRLF endings and malformed lines", async () => {
    const values = await collect(streamOf([encode('\n{"a":1}\r\n\r\nnot json\n{"b":2}\n')]));
    expect(values).toEqual([{ a: 1 }, { b: 2 }]);
  });
});
