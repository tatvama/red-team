// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import { editFileTool, listFilesTool, readFileTool, searchFilesTool, writeFileTool } from "./files";
import type { ToolDefinition } from "./types";

const ctx = { signal: new AbortController().signal, conversationId: "test" };
let workspace: string;

/** Parses like the agent loop does, so schema defaults apply. */
function call<S extends z.ZodObject>(tool: ToolDefinition<S>, input: z.input<S>) {
  return tool.run(tool.schema.parse(input), ctx);
}

async function put(relative: string, content: string | Buffer) {
  const file = path.join(workspace, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}

const readBack = (relative: string) => fs.readFile(path.join(workspace, relative), "utf8");

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tatvam-files-"));
  vi.stubEnv("WORKSPACE_DIR", workspace);
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

describe("list_files", () => {
  beforeEach(async () => {
    await put("src/app.ts", "");
    await put("src/lib/util.ts", "");
    await put("src/page.tsx", "");
    await put("README.md", "");
    await put("node_modules/pkg/index.js", "");
    await put(".git/HEAD", "");
  });

  it("lists recursively with directory markers and skips ignored folders", async () => {
    const result = await call(listFilesTool, {});
    expect(result.status).toBe("ok");
    expect(result.content.split("\n")).toEqual(["README.md", "src/", "src/app.ts", "src/lib/", "src/lib/util.ts", "src/page.tsx"]);
  });

  it("filters with a glob relative to the given path", async () => {
    expect((await call(listFilesTool, { pattern: "**/*.ts" })).content.split("\n")).toEqual(["src/app.ts", "src/lib/util.ts"]);
    expect((await call(listFilesTool, { pattern: "src/*.tsx" })).content).toBe("src/page.tsx");
    expect((await call(listFilesTool, { path: "src/lib", pattern: "*.ts" })).content).toBe("src/lib/util.ts");
  });

  it("notes truncation", async () => {
    const result = await call(listFilesTool, { max_results: 2 });
    expect(result.content).toContain("README.md\nsrc/\n[showing the first 2 entries");
  });

  it("refuses paths outside the workspace", async () => {
    const result = await call(listFilesTool, { path: "../" });
    expect(result).toEqual({ status: "error", content: expect.stringContaining("escapes the workspace") });
  });

  it("summarizes", () => {
    expect(listFilesTool.summarize(listFilesTool.schema.parse({ path: "src" }))).toBe("List files in src");
  });
});

describe("read_file", () => {
  it("returns numbered lines", async () => {
    await put("a.txt", "one\ntwo\r\nthree\n");
    const result = await call(readFileTool, { path: "a.txt" });
    expect(result).toEqual({ status: "ok", content: "     1\tone\n     2\ttwo\n     3\tthree" });
  });

  it("pages with offset and limit and says how to continue", async () => {
    await put("big.txt", Array.from({ length: 1234 }, (_, i) => `line ${i + 1}`).join("\n"));
    const first = await call(readFileTool, { path: "big.txt" });
    expect(first.content).toMatch(/^ {5}1\tline 1\n/);
    expect(first.content).toContain("[lines 1-400 of 1234; continue with offset 401]");
    const page = await call(readFileTool, { path: "big.txt", offset: 1230, limit: 10 });
    expect(page.content).toBe(
      ["  1230\tline 1230", "  1231\tline 1231", "  1232\tline 1232", "  1233\tline 1233", "  1234\tline 1234", "[lines 1230-1234 of 1234]"].join("\n"),
    );
    expect((await call(readFileTool, { path: "big.txt", offset: 2000 })).status).toBe("error");
  });

  it("refuses binary, oversized, missing and escaping files", async () => {
    await put("bin.dat", Buffer.from([1, 2, 0, 3]));
    await put("huge.txt", Buffer.alloc(5 * 1024 * 1024 + 1, 97));
    expect(await call(readFileTool, { path: "bin.dat" })).toEqual({ status: "error", content: "bin.dat looks like a binary file" });
    expect((await call(readFileTool, { path: "huge.txt" })).content).toContain("above the 5.0 MB limit");
    expect(await call(readFileTool, { path: "nope.txt" })).toEqual({ status: "error", content: "Not found: nope.txt" });
    expect((await call(readFileTool, { path: "../outside.txt" })).status).toBe("error");
    expect((await call(readFileTool, { path: "C:\\Windows\\win.ini" })).status).toBe("error");
  });

  it("summarizes the line range", () => {
    expect(readFileTool.summarize(readFileTool.schema.parse({ path: "src/app.ts" }))).toBe("Read src/app.ts (lines 1-400)");
  });
});

describe("search_files", () => {
  beforeEach(async () => {
    await put("src/app.tsx", "import { useState } from 'react';\nconst [a, setA] = useState(0);\n");
    await put("src/other.ts", "// USESTATE in caps\n");
    await put("node_modules/react/index.js", "useState");
    await put("bin.dat", Buffer.from("useState\0"));
  });

  it("finds matches as path:line: text", async () => {
    const result = await call(searchFilesTool, { pattern: "useState\\(" });
    expect(result).toEqual({ status: "ok", content: "src/app.tsx:2: const [a, setA] = useState(0);" });
  });

  it("supports case-insensitive search, globs and single files", async () => {
    const all = await call(searchFilesTool, { pattern: "usestate", case_insensitive: true });
    expect(all.content.split("\n")).toEqual([
      "src/app.tsx:1: import { useState } from 'react';",
      "src/app.tsx:2: const [a, setA] = useState(0);",
      "src/other.ts:1: // USESTATE in caps",
    ]);
    const globbed = await call(searchFilesTool, { pattern: "usestate", case_insensitive: true, glob: "*.ts" });
    expect(globbed.content).toBe("src/other.ts:1: // USESTATE in caps");
    const single = await call(searchFilesTool, { pattern: "import", path: "src/app.tsx" });
    expect(single.content).toBe("src/app.tsx:1: import { useState } from 'react';");
  });

  it("caps results and trims long lines", async () => {
    await put("long.txt", `${"x".repeat(400)}needle\nneedle 2\nneedle 3\n`);
    const result = await call(searchFilesTool, { pattern: "needle", path: "long.txt", max_results: 2 });
    const lines = result.content.split("\n");
    expect(lines[0]).toBe(`long.txt:1: ${"x".repeat(300)}...`);
    expect(lines[1]).toBe("long.txt:2: needle 2");
    expect(lines[2]).toContain("stopped at 2 matches");
  });

  it("reports invalid regexes, no matches and escapes", async () => {
    const invalid = await call(searchFilesTool, { pattern: "([a-" });
    expect(invalid.status).toBe("error");
    expect(invalid.content).toContain("Invalid regular expression");
    expect(await call(searchFilesTool, { pattern: "zzz" })).toEqual({ status: "ok", content: "No matches for /zzz/ in the workspace" });
    expect((await call(searchFilesTool, { pattern: "x", path: "../" })).status).toBe("error");
  });

  it("summarizes", () => {
    expect(searchFilesTool.summarize(searchFilesTool.schema.parse({ pattern: "useState", path: "src" }))).toBe(
      "Search for /useState/ in src",
    );
  });

  it("stops a catastrophically backtracking regex instead of hanging", async () => {
    await put("redos.txt", `${"a".repeat(40)}!`);
    const started = Date.now();
    const result = await call(searchFilesTool, { pattern: "(a+)+$", path: "redos.txt" });
    expect(result.status).toBe("error");
    expect(result.content).toContain("Search stopped");
    expect(Date.now() - started).toBeLessThan(20_000);
  }, 30_000);
});

describe("write_file", () => {
  it("creates files with parent folders and reports size and line count", async () => {
    const result = await call(writeFileTool, { path: "notes/todo.md", content: "a\nb\n" });
    expect(result).toEqual({ status: "ok", content: "Wrote 4 B (2 lines) to notes/todo.md (created new file)" });
    expect(await readBack("notes/todo.md")).toBe("a\nb\n");
  });

  it("says when it overwrote a file", async () => {
    await put("x.txt", "old");
    const result = await call(writeFileTool, { path: "x.txt", content: "y".repeat(1300) });
    expect(result.content).toBe("Wrote 1.3 KB (1 line) to x.txt (overwrote existing file)");
  });

  it("refuses escapes and directories", async () => {
    expect((await call(writeFileTool, { path: "../evil.txt", content: "x" })).status).toBe("error");
    expect((await call(writeFileTool, { path: "/tmp/evil.txt", content: "x" })).status).toBe("error");
    await fs.mkdir(path.join(workspace, "dir"));
    expect(await call(writeFileTool, { path: "dir", content: "x" })).toEqual({ status: "error", content: "dir is a directory" });
    await expect(fs.stat(path.join(workspace, "..", "evil.txt"))).rejects.toThrow();
  });

  it("summarizes with the size", () => {
    expect(writeFileTool.summarize({ path: "notes/todo.md", content: "x".repeat(1229) })).toBe("Write 1.2 KB to notes/todo.md");
  });
});

describe("edit_file", () => {
  it("replaces a unique match", async () => {
    await put("src/app.ts", "const a = 1;\nconst b = 2;\n");
    const result = await call(editFileTool, { path: "src/app.ts", old_string: "const b = 2;", new_string: "const b = 3;" });
    expect(result).toEqual({ status: "ok", content: "Edited src/app.ts: replaced 1 occurrence" });
    expect(await readBack("src/app.ts")).toBe("const a = 1;\nconst b = 3;\n");
  });

  it("refuses ambiguous matches unless replace_all is set", async () => {
    await put("a.ts", "x = 1;\nx = 1;\nx = 1;\n");
    const ambiguous = await call(editFileTool, { path: "a.ts", old_string: "x = 1;", new_string: "x = 2;" });
    expect(ambiguous.status).toBe("error");
    expect(ambiguous.content).toContain("matches 3 times");
    expect(await readBack("a.ts")).toBe("x = 1;\nx = 1;\nx = 1;\n");
    const all = await call(editFileTool, { path: "a.ts", old_string: "x = 1;", new_string: "x = 2;", replace_all: true });
    expect(all.content).toBe("Edited a.ts: replaced 3 occurrences");
    expect(await readBack("a.ts")).toBe("x = 2;\nx = 2;\nx = 2;\n");
  });

  it("reports missing text, missing files, identical strings and escapes", async () => {
    await put("a.ts", "hello\n");
    const notFound = await call(editFileTool, { path: "a.ts", old_string: "goodbye", new_string: "x" });
    expect(notFound.status).toBe("error");
    expect(notFound.content).toContain("not found");
    const missing = await call(editFileTool, { path: "nope.ts", old_string: "a", new_string: "b" });
    expect(missing).toEqual({ status: "error", content: "nope.ts does not exist. Use write_file to create it." });
    const same = await call(editFileTool, { path: "a.ts", old_string: "hello", new_string: "hello" });
    expect(same.status).toBe("error");
    expect((await call(editFileTool, { path: "../a.ts", old_string: "a", new_string: "b" })).status).toBe("error");
  });

  it("preserves CRLF line endings when the model sends LF", async () => {
    await put("win.txt", "line one\r\nline two\r\nline three\r\n");
    const result = await call(editFileTool, {
      path: "win.txt",
      old_string: "line one\nline two",
      new_string: "line 1\nline 2\nline 2b",
    });
    expect(result.status).toBe("ok");
    expect(await readBack("win.txt")).toBe("line 1\r\nline 2\r\nline 2b\r\nline three\r\n");
  });

  it("keeps LF files LF and treats $ patterns in new_string literally", async () => {
    await put("unix.txt", "a\nb\n");
    await call(editFileTool, { path: "unix.txt", old_string: "a\r\nb", new_string: "$& $1 $$\r\nc" });
    expect(await readBack("unix.txt")).toBe("$& $1 $$\nc\n");
  });
});

describe("git metadata", () => {
  it.each([".git/config", "sub/.GIT/x", ".Git/hooks/pre-commit", "a/../.git/HEAD", ".git./config", "GIT~1/config"])(
    "refuses to write %s",
    async (target) => {
      const result = await call(writeFileTool, { path: target, content: "x" });
      expect(result).toEqual({ status: "error", content: `Git metadata cannot be edited: ${target}` });
    },
  );

  it("refuses to edit .git files but still reads them", async () => {
    await put(".git/config", "[core]\n");
    const edit = await call(editFileTool, { path: ".git/config", old_string: "[core]", new_string: "[hooks]" });
    expect(edit).toEqual({ status: "error", content: "Git metadata cannot be edited: .git/config" });
    expect(await readBack(".git/config")).toBe("[core]\n");
    expect(await call(readFileTool, { path: ".git/config" })).toEqual({ status: "ok", content: "     1\t[core]" });
    // Names that only contain ".git" are ordinary files.
    expect((await call(writeFileTool, { path: ".gitignore", content: "dist/\n" })).status).toBe("ok");
    expect((await call(writeFileTool, { path: "docs/.github/x.md", content: "x" })).status).toBe("ok");
  });

  it("refuses to write through a link that points into .git", async (ctx) => {
    await put(".git/hooks/README", "hooks\n");
    try {
      const type = process.platform === "win32" ? "junction" : "dir";
      await fs.symlink(path.join(workspace, ".git", "hooks"), path.join(workspace, "innocent"), type);
    } catch {
      ctx.skip();
    }
    const result = await call(writeFileTool, { path: "innocent/pre-commit", content: "#!/bin/sh\n" });
    expect(result).toEqual({ status: "error", content: "Git metadata cannot be edited: innocent/pre-commit" });
    await expect(fs.stat(path.join(workspace, ".git", "hooks", "pre-commit"))).rejects.toThrow();
  });
});
