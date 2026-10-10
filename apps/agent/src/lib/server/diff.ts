import type { DiffFile, DiffHunk, DiffLine } from "@/lib/contract";

// Parser for `git diff` output (unified format with git's extended headers), plus helpers that
// describe untracked files the same way. Responses are capped so a huge change cannot flood the UI.

export type DiffLimits = { maxFiles: number; maxLinesPerFile: number; maxTotalLines: number };
export const DIFF_LIMITS: DiffLimits = { maxFiles: 200, maxLinesPerFile: 3000, maxTotalLines: 20_000 };

/** One response's allowance. The tracked diff and the untracked files draw from the same budget. */
export class DiffBudget {
  files = 0;
  lines = 0;
  /** Set when any limit cut something. */
  truncated = false;
  constructor(readonly limits: DiffLimits = DIFF_LIMITS) {}

  /** Claims a file slot, or records the truncation and returns false when none are left. */
  takeFile(): boolean {
    if (this.files >= this.limits.maxFiles) {
      this.truncated = true;
      return false;
    }
    this.files++;
    return true;
  }
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };

/** Decodes a C-quoted name as git writes it (`"a\tb"`, `"caf\303\251"`); octal escapes are raw bytes. */
function readQuoted(text: string): { value: string; rest: string } | null {
  if (!text.startsWith('"')) return null;
  const bytes: number[] = [];
  for (let index = 1; index < text.length; index++) {
    const char = text[index];
    if (char === '"') return { value: Buffer.from(bytes).toString("utf8"), rest: text.slice(index + 1) };
    if (char === "\\") {
      const next = text[index + 1] ?? "";
      if (next in ESCAPES) {
        bytes.push(ESCAPES[next]);
        index++;
      } else if (/[0-7]/.test(next)) {
        const octal = /^[0-7]{1,3}/.exec(text.slice(index + 1))![0];
        bytes.push(Number.parseInt(octal, 8) & 0xff);
        index += octal.length;
      } else {
        bytes.push(92);
      }
      continue;
    }
    const codePoint = text.codePointAt(index)!;
    const whole = String.fromCodePoint(codePoint);
    bytes.push(...Buffer.from(whole, "utf8"));
    index += whole.length - 1;
  }
  return null;
}

function stripPrefix(name: string, prefix: string): string {
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

/** A path from a `---`/`+++` line: null for /dev/null. Git appends a tab when the name has a space. */
function markerPath(value: string, prefix: string): string | null {
  const quoted = readQuoted(value);
  const name = quoted ? quoted.value : value.endsWith("\t") ? value.slice(0, -1) : value;
  return name === "/dev/null" ? null : stripPrefix(name, prefix);
}

/** A path from `rename from`, `copy to` and similar lines, which carry no a/ or b/ prefix. */
function plainPath(value: string): string {
  return readQuoted(value)?.value ?? value;
}

/** Both names from `diff --git a/x b/y`. Unquoted names with spaces are split using a/ = b/ symmetry. */
function headerPaths(rest: string): { a: string | null; b: string | null } {
  const first = readQuoted(rest);
  if (first) {
    const tail = first.rest.replace(/^ /, "");
    const second = readQuoted(tail)?.value ?? tail;
    return { a: stripPrefix(first.value, "a/"), b: stripPrefix(second, "b/") };
  }
  if (rest.endsWith('"')) {
    const at = rest.lastIndexOf(' "');
    const second = at > 0 ? readQuoted(rest.slice(at + 1)) : null;
    if (second) return { a: stripPrefix(rest.slice(0, at), "a/"), b: stripPrefix(second.value, "b/") };
  }
  if (rest.length % 2 === 1) {
    const half = (rest.length - 1) / 2;
    const a = rest.slice(0, half);
    const b = rest.slice(half + 1);
    if (rest[half] === " " && a.startsWith("a/") && b.startsWith("b/") && a.slice(2) === b.slice(2)) {
      return { a: a.slice(2), b: b.slice(2) };
    }
  }
  const split = rest.indexOf(" b/");
  if (split > 0) return { a: stripPrefix(rest.slice(0, split), "a/"), b: rest.slice(split + 3) };
  return { a: null, b: null };
}

type FileMeta = {
  headerOld: string | null;
  headerNew: string | null;
  /** undefined: no `---` line seen; null: /dev/null. */
  minus?: string | null;
  plus?: string | null;
  renameFrom?: string;
  renameTo?: string;
  copyFrom?: string;
  copyTo?: string;
  isNew: boolean;
  isDeleted: boolean;
};

function settle(file: DiffFile, meta: FileMeta) {
  const fallback = meta.headerNew ?? meta.headerOld ?? "(unknown)";
  if (meta.renameFrom !== undefined || meta.renameTo !== undefined) {
    file.status = "renamed";
    file.oldPath = meta.renameFrom ?? meta.headerOld;
    file.path = meta.renameTo ?? meta.headerNew ?? fallback;
  } else if (meta.copyTo !== undefined || meta.copyFrom !== undefined) {
    // A copy is a new file as far as review is concerned.
    file.status = "added";
    file.path = meta.copyTo ?? meta.headerNew ?? fallback;
  } else if (meta.isNew || meta.minus === null) {
    file.status = "added";
    file.path = meta.plus ?? meta.headerNew ?? fallback;
  } else if (meta.isDeleted || meta.plus === null) {
    file.status = "deleted";
    file.path = meta.minus ?? meta.headerOld ?? fallback;
  } else {
    file.status = "modified";
    file.path = meta.plus ?? meta.headerNew ?? meta.minus ?? fallback;
  }
}

function newFile(): DiffFile {
  return { path: "", oldPath: null, status: "modified", binary: false, additions: 0, deletions: 0, hunks: [], truncated: false };
}

/**
 * Parses `git diff` output into files, hunks and numbered lines. Hunk line counts decide where a hunk
 * ends, so content such as a deleted `-- comment` line is never mistaken for a header. Lines past the
 * budget are still counted in additions and deletions but are not returned.
 */
export function parseUnifiedDiff(text: string, budget: DiffBudget = new DiffBudget()): DiffFile[] {
  const { maxLinesPerFile, maxTotalLines } = budget.limits;
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let meta: FileMeta | null = null;
  let hunk: DiffHunk | null = null;
  let hunkKept = false;
  let stored = 0;
  let oldLine = 0;
  let newLine = 0;
  let oldLeft = 0;
  let newLeft = 0;

  const finish = () => {
    if (file && meta) settle(file, meta);
    file = null;
    meta = null;
    hunk = null;
  };
  const begin = (paths: { a: string | null; b: string | null }): FileMeta | null => {
    finish();
    if (!budget.takeFile()) return null;
    const started = newFile();
    const startedMeta: FileMeta = { headerOld: paths.a, headerNew: paths.b, isNew: false, isDeleted: false };
    file = started;
    meta = startedMeta;
    files.push(started);
    stored = 0;
    return startedMeta;
  };
  const store = (current: DiffFile, line: DiffLine) => {
    if (!hunkKept || stored >= maxLinesPerFile || budget.lines >= maxTotalLines) {
      current.truncated = true;
      budget.truncated = true;
      return;
    }
    hunk!.lines.push(line);
    stored++;
    budget.lines++;
  };

  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();

  for (const raw of lines) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const current = file as DiffFile | null;
    const currentMeta = meta as FileMeta | null;

    if (current && hunk && (oldLeft > 0 || newLeft > 0)) {
      const marker = line[0];
      if (marker === "\\") continue; // "\ No newline at end of file"
      if (marker === "+" && newLeft > 0) {
        current.additions++;
        newLeft--;
        store(current, { type: "add", text: line.slice(1), oldLine: null, newLine: newLine++ });
        continue;
      }
      if (marker === "-" && oldLeft > 0) {
        current.deletions++;
        oldLeft--;
        store(current, { type: "del", text: line.slice(1), oldLine: oldLine++, newLine: null });
        continue;
      }
      if ((marker === " " || line === "") && oldLeft > 0 && newLeft > 0) {
        oldLeft--;
        newLeft--;
        store(current, { type: "context", text: line.slice(1), oldLine: oldLine++, newLine: newLine++ });
        continue;
      }
      // Malformed or cut-off hunk: end it and read this line as a header.
      oldLeft = 0;
      newLeft = 0;
    }

    if (line.startsWith("diff --git ")) {
      if (!begin(headerPaths(line.slice("diff --git ".length)))) break;
      continue;
    }
    if (line.startsWith("\\")) continue;
    if (line.startsWith("--- ") && (!current || current.hunks.length > 0 || hunk)) {
      // Plain unified diff without a `diff --git` line.
      const started = begin({ a: null, b: null });
      if (!started) break;
      started.minus = markerPath(line.slice(4), "a/");
      continue;
    }
    if (!current || !currentMeta) continue;

    if (line.startsWith("@@")) {
      const match = HUNK_HEADER.exec(line);
      if (!match) continue;
      oldLine = Number(match[1]);
      newLine = Number(match[3]);
      oldLeft = match[2] === undefined ? 1 : Number(match[2]);
      newLeft = match[4] === undefined ? 1 : Number(match[4]);
      hunk = { header: line, lines: [] };
      hunkKept = stored < maxLinesPerFile && budget.lines < maxTotalLines;
      if (hunkKept) current.hunks.push(hunk);
      else {
        current.truncated = true;
        budget.truncated = true;
      }
      continue;
    }
    if (hunk) continue; // Only headers may follow a finished hunk, and those were handled above.

    if (line.startsWith("--- ")) currentMeta.minus = markerPath(line.slice(4), "a/");
    else if (line.startsWith("+++ ")) currentMeta.plus = markerPath(line.slice(4), "b/");
    else if (line.startsWith("new file mode")) currentMeta.isNew = true;
    else if (line.startsWith("deleted file mode")) currentMeta.isDeleted = true;
    else if (line.startsWith("rename from ")) currentMeta.renameFrom = plainPath(line.slice(12));
    else if (line.startsWith("rename to ")) currentMeta.renameTo = plainPath(line.slice(10));
    else if (line.startsWith("copy from ")) currentMeta.copyFrom = plainPath(line.slice(10));
    else if (line.startsWith("copy to ")) currentMeta.copyTo = plainPath(line.slice(8));
    else if (line.startsWith("Binary files ") || line === "GIT binary patch") current.binary = true;
  }
  finish();
  return files;
}

// ── Untracked files ─────────────────────────────────────────────────────────

/** Git's own heuristic: a NUL byte in the first 8000 bytes means binary. */
export function isBinary(content: Buffer): boolean {
  return content.subarray(0, 8000).includes(0);
}

function contentLines(content: Buffer): string[] {
  const lines = content.toString("utf8").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

/**
 * Describes an untracked file as an added file. `partial` means `content` is only the start of the
 * file; `totalLines` then gives the real line count. Returns null when the file budget is used up.
 */
export function addedFile(
  filePath: string,
  content: Buffer,
  budget: DiffBudget,
  options: { partial?: boolean; totalLines?: number } = {},
): DiffFile | null {
  if (!budget.takeFile()) return null;
  const file: DiffFile = { ...newFile(), path: filePath, status: "added" };
  if (isBinary(content)) {
    file.binary = true;
    return file;
  }
  let lines = contentLines(content);
  // The last line of a partial read is probably cut in the middle.
  if (options.partial && lines.length > 1) lines = lines.slice(0, -1);
  file.additions = options.totalLines ?? lines.length;
  if (options.partial) {
    file.truncated = true;
    budget.truncated = true;
  }
  if (lines.length === 0) return file;
  const room = Math.max(0, Math.min(budget.limits.maxLinesPerFile, budget.limits.maxTotalLines - budget.lines));
  const kept = lines.slice(0, room);
  if (kept.length < lines.length) {
    file.truncated = true;
    budget.truncated = true;
  }
  if (kept.length > 0) {
    budget.lines += kept.length;
    file.hunks.push({
      header: `@@ -0,0 +1,${file.additions} @@`,
      lines: kept.map((text, index) => ({ type: "add", text, oldLine: null, newLine: index + 1 })),
    });
  }
  return file;
}

/** The same untracked file as unified diff text, for the model-facing git_diff tool. */
export function formatAddedFile(filePath: string, content: Buffer): string {
  const header = `diff --git a/${filePath} b/${filePath}\nnew file mode 100644\n`;
  if (isBinary(content)) return `${header}Binary files /dev/null and b/${filePath} differ\n`;
  if (content.length === 0) return header;
  const text = content.toString("utf8");
  const lines = text.split("\n");
  const endsWithNewline = lines.at(-1) === "";
  if (endsWithNewline) lines.pop();
  const body = lines.map((line) => `+${line}`).join("\n");
  const tail = endsWithNewline ? "\n" : "\n\\ No newline at end of file\n";
  return `${header}--- /dev/null\n+++ b/${filePath}\n@@ -0,0 +1,${lines.length} @@\n${body}${tail}`;
}
