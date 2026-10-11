// @vitest-environment node
import { describe, expect, it } from "vitest";
import { DiffBudget, addedFile, formatAddedFile, parseUnifiedDiff } from "./diff";

const join = (...lines: string[]) => `${lines.join("\n")}\n`;

describe("parseUnifiedDiff", () => {
  it("numbers lines across hunks and counts additions and deletions", () => {
    const [file] = parseUnifiedDiff(
      join(
        "diff --git a/src/app.ts b/src/app.ts",
        "index 1111111..2222222 100644",
        "--- a/src/app.ts",
        "+++ b/src/app.ts",
        "@@ -1,3 +1,4 @@ function main() {",
        " one",
        "-two",
        "+TWO",
        "+two and a half",
        " three",
        "@@ -10,2 +11,2 @@",
        " ten",
        "-eleven",
        "+ELEVEN",
      ),
    );
    expect(file).toMatchObject({ path: "src/app.ts", oldPath: null, status: "modified", binary: false, additions: 3, deletions: 2 });
    expect(file.hunks.map((hunk) => hunk.header)).toEqual(["@@ -1,3 +1,4 @@ function main() {", "@@ -10,2 +11,2 @@"]);
    expect(file.hunks[0].lines).toEqual([
      { type: "context", text: "one", oldLine: 1, newLine: 1 },
      { type: "del", text: "two", oldLine: 2, newLine: null },
      { type: "add", text: "TWO", oldLine: null, newLine: 2 },
      { type: "add", text: "two and a half", oldLine: null, newLine: 3 },
      { type: "context", text: "three", oldLine: 3, newLine: 4 },
    ]);
    expect(file.hunks[1].lines.map((line) => [line.type, line.oldLine, line.newLine])).toEqual([
      ["context", 10, 11],
      ["del", 11, null],
      ["add", null, 12],
    ]);
  });

  it("handles a missing newline at end of file and hunk headers without counts", () => {
    const [file] = parseUnifiedDiff(
      join(
        "diff --git a/a.txt b/a.txt",
        "--- a/a.txt",
        "+++ b/a.txt",
        "@@ -1 +1 @@",
        "-old",
        "\\ No newline at end of file",
        "+new",
        "\\ No newline at end of file",
      ),
    );
    expect(file.hunks[0].lines).toEqual([
      { type: "del", text: "old", oldLine: 1, newLine: null },
      { type: "add", text: "new", oldLine: null, newLine: 1 },
    ]);
    expect([file.additions, file.deletions]).toEqual([1, 1]);
  });

  it("strips CRLF line endings from both headers and content", () => {
    const text = [
      "diff --git a/win.txt b/win.txt",
      "--- a/win.txt",
      "+++ b/win.txt",
      "@@ -1,2 +1,2 @@",
      " keep",
      "-before",
      "+after",
      "",
    ].join("\r\n");
    const [file] = parseUnifiedDiff(text);
    expect(file.path).toBe("win.txt");
    expect(file.hunks[0].lines.map((line) => line.text)).toEqual(["keep", "before", "after"]);
  });

  it("reads unicode paths, raw or C-quoted with octal bytes, tabs and spaces", () => {
    const files = parseUnifiedDiff(
      join(
        "diff --git a/docs/café.md b/docs/café.md",
        "--- a/docs/café.md",
        "+++ b/docs/café.md",
        "@@ -1 +1 @@",
        "-a",
        "+b",
        'diff --git "a/caf\\303\\251 \\346\\227\\245.txt" "b/caf\\303\\251 \\346\\227\\245.txt"',
        "new file mode 100644",
        "--- /dev/null",
        '+++ "b/caf\\303\\251 \\346\\227\\245.txt"\t',
        "@@ -0,0 +1 @@",
        "+x",
        'diff --git "a/tab\\there" "b/tab\\there"',
        "deleted file mode 100644",
        '--- "a/tab\\there"',
        "+++ /dev/null",
        "@@ -1 +0,0 @@",
        "-gone",
        "diff --git a/with space.txt b/with space.txt",
        "--- a/with space.txt\t",
        "+++ b/with space.txt\t",
        "@@ -1 +1 @@",
        "-1",
        "+2",
      ),
    );
    expect(files.map((file) => [file.path, file.status])).toEqual([
      ["docs/café.md", "modified"],
      ["café 日.txt", "added"],
      ["tab\there", "deleted"],
      ["with space.txt", "modified"],
    ]);
  });

  it("describes new and deleted empty files, which have no hunks", () => {
    const files = parseUnifiedDiff(
      join(
        "diff --git a/empty.txt b/empty.txt",
        "new file mode 100644",
        "index 0000000..e69de29",
        "diff --git a/old empty.txt b/old empty.txt",
        "deleted file mode 100644",
        "index e69de29..0000000",
      ),
    );
    expect(files).toEqual([
      { path: "empty.txt", oldPath: null, status: "added", binary: false, additions: 0, deletions: 0, hunks: [], truncated: false },
      { path: "old empty.txt", oldPath: null, status: "deleted", binary: false, additions: 0, deletions: 0, hunks: [], truncated: false },
    ]);
  });

  it("reads renames, binary files and mode-only changes", () => {
    const files = parseUnifiedDiff(
      join(
        "diff --git a/old name.txt b/new name.txt",
        "similarity index 90%",
        "rename from old name.txt",
        "rename to new name.txt",
        "index 1111111..2222222 100644",
        "--- a/old name.txt\t",
        "+++ b/new name.txt\t",
        "@@ -1 +1 @@",
        "-a",
        "+b",
        "diff --git a/img.png b/img.png",
        "index 1111111..2222222 100644",
        "Binary files a/img.png and b/img.png differ",
        "diff --git a/run.sh b/run.sh",
        "old mode 100644",
        "new mode 100755",
      ),
    );
    expect(files.map((file) => [file.path, file.oldPath, file.status, file.binary, file.hunks.length])).toEqual([
      ["new name.txt", "old name.txt", "renamed", false, 1],
      ["img.png", null, "modified", true, 0],
      ["run.sh", null, "modified", false, 0],
    ]);
  });

  it("never mistakes content lines that look like headers for headers", () => {
    const files = parseUnifiedDiff(
      join(
        "diff --git a/q.sql b/q.sql",
        "--- a/q.sql",
        "+++ b/q.sql",
        "@@ -1,2 +1,2 @@",
        "--- a comment",
        "+++ a counter",
        " diff --git a/x b/x",
      ),
    );
    expect(files).toHaveLength(1);
    expect(files[0].hunks[0].lines).toEqual([
      { type: "del", text: "-- a comment", oldLine: 1, newLine: null },
      { type: "add", text: "++ a counter", oldLine: null, newLine: 1 },
      { type: "context", text: "diff --git a/x b/x", oldLine: 2, newLine: 2 },
    ]);
  });

  it("caps lines per file, lines in total and the number of files", () => {
    const fileDiff = (name: string, count: number) => [
      `diff --git a/${name} b/${name}`,
      "--- /dev/null",
      `+++ b/${name}`,
      `@@ -0,0 +1,${count} @@`,
      ...Array.from({ length: count }, (_, index) => `+line ${index + 1}`),
    ];
    const budget = new DiffBudget({ maxFiles: 3, maxLinesPerFile: 4, maxTotalLines: 6 });
    const files = parseUnifiedDiff(join(...fileDiff("a", 5), ...fileDiff("b", 3), ...fileDiff("c", 2), ...fileDiff("d", 1)), budget);
    expect(files.map((file) => [file.path, file.hunks.flatMap((hunk) => hunk.lines).length, file.additions, file.truncated])).toEqual([
      ["a", 4, 5, true],
      ["b", 2, 3, true],
      ["c", 0, 2, true],
    ]);
    expect(budget.truncated).toBe(true);
    expect(budget.lines).toBe(6);
  });
});

describe("untracked files", () => {
  it("describes text, empty, binary and partial files as additions", () => {
    const budget = new DiffBudget({ maxFiles: 4, maxLinesPerFile: 2, maxTotalLines: 100 });
    const text = addedFile("notes.md", Buffer.from("one\r\ntwo\nthree"), budget)!;
    expect(text).toMatchObject({ path: "notes.md", status: "added", additions: 3, truncated: true });
    expect(text.hunks[0]).toEqual({
      header: "@@ -0,0 +1,3 @@",
      lines: [
        { type: "add", text: "one", oldLine: null, newLine: 1 },
        { type: "add", text: "two", oldLine: null, newLine: 2 },
      ],
    });
    expect(addedFile("empty", Buffer.alloc(0), budget)).toMatchObject({ additions: 0, hunks: [], binary: false });
    expect(addedFile("pic.bin", Buffer.from([1, 0, 2]), budget)).toMatchObject({ binary: true, hunks: [] });
    const partial = addedFile("big.log", Buffer.from("a\nb\npartial li"), budget, { partial: true, totalLines: 9000 })!;
    expect(partial).toMatchObject({ additions: 9000, truncated: true });
    expect(partial.hunks[0].lines.map((line) => line.text)).toEqual(["a", "b"]);
    expect(addedFile("fifth", Buffer.from("x"), budget)).toBeNull();
    expect(budget.truncated).toBe(true);
  });

  it("formats untracked files as unified diff text", () => {
    expect(formatAddedFile("a.txt", Buffer.from("x\ny\n"))).toBe(
      "diff --git a/a.txt b/a.txt\nnew file mode 100644\n--- /dev/null\n+++ b/a.txt\n@@ -0,0 +1,2 @@\n+x\n+y\n",
    );
    expect(formatAddedFile("b.txt", Buffer.from("z"))).toContain("+z\n\\ No newline at end of file\n");
    expect(formatAddedFile("c.bin", Buffer.from([0]))).toContain("Binary files /dev/null and b/c.bin differ");
    expect(formatAddedFile("d.txt", Buffer.alloc(0))).toBe("diff --git a/d.txt b/d.txt\nnew file mode 100644\n");
  });
});
