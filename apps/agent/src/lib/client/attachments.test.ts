import { describe, expect, it } from "vitest";
import { appendAttachments, looksBinary } from "./attachments";

describe("looksBinary", () => {
  it("flags NUL bytes in the first 8 KB only", () => {
    expect(looksBinary(new TextEncoder().encode("plain text\n"))).toBe(false);
    expect(looksBinary(Uint8Array.of(0x89, 0x50, 0x00, 0x47))).toBe(true);
    const late = new Uint8Array(9000).fill(0x61);
    late[8500] = 0;
    expect(looksBinary(late)).toBe(false);
  });
});

describe("appendAttachments", () => {
  it("appends each file as a labelled fenced block", () => {
    const content = appendAttachments("Review this", [{ id: "1", name: "app.ts", size: 10, text: "const a = 1;" }]);
    expect(content).toBe("Review this\n\nFile: app.ts\n```typescript\nconst a = 1;\n```");
  });

  it("uses a longer fence when the file contains backticks", () => {
    const content = appendAttachments("", [{ id: "1", name: "notes.md", size: 10, text: "```js\nx\n```\n" }]);
    expect(content).toBe("File: notes.md\n````markdown\n```js\nx\n```\n````");
  });
});
