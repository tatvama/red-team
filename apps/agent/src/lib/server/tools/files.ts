import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { z } from "zod";
import { MAX_TOOL_OUTPUT_CHARS, truncate, type ToolDefinition, type ToolOutput } from "./types";
import {
  WorkspacePathError,
  globToRegExp,
  resolveWorkspacePath,
  resolveWritablePath,
  toWorkspaceRelative,
  walkWorkspace,
} from "./workspace-path";

const MAX_READ_BYTES = 5 * 1024 * 1024;
const MAX_SEARCH_FILE_BYTES = 1024 * 1024;
const MAX_LINE_CHARS = 2000;
const MAX_MATCH_LINE_CHARS = 300;
/** Wall-clock budget for one search, so a pathological regex cannot stall the server. */
const SEARCH_BUDGET_MS = 10_000;

const always = () => ({ ok: true as const });
const ok = (content: string): ToolOutput => ({ status: "ok", content: truncate(content) });
const fail = (content: string): ToolOutput => ({ status: "error", content });

/** Turns expected filesystem failures into a model-readable error instead of throwing. */
function describeError(error: unknown, displayPath: string): ToolOutput {
  if (error instanceof WorkspacePathError) return fail(error.message);
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === "ENOENT") return fail(`Not found: ${displayPath}`);
  if (code === "EISDIR") return fail(`${displayPath} is a directory`);
  if (code === "ENOTDIR") return fail(`A parent of ${displayPath} is not a directory`);
  if (code === "EACCES" || code === "EPERM") return fail(`Permission denied: ${displayPath}`);
  return fail(`Failed on ${displayPath}: ${error instanceof Error ? error.message : String(error)}`);
}

function where(p: string): string {
  return p === "." || p === "./" || p === "" ? "the workspace" : p;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function countLines(text: string): number {
  if (text === "") return 0;
  const lines = text.split("\n").length;
  return text.endsWith("\n") ? lines - 1 : lines;
}

function splitLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/** Reads a text file, refusing oversized and binary files with a model-readable error. */
async function readText(absolute: string, displayPath: string): Promise<string | ToolOutput> {
  const stat = await fs.stat(absolute);
  if (stat.isDirectory()) return fail(`${displayPath} is a directory. Use list_files to see its contents.`);
  // FIFOs, sockets and devices could block a read forever.
  if (!stat.isFile()) return fail(`${displayPath} is not a regular file`);
  if (stat.size > MAX_READ_BYTES) {
    return fail(`${displayPath} is ${formatBytes(stat.size)}, above the ${formatBytes(MAX_READ_BYTES)} limit`);
  }
  const buffer = await fs.readFile(absolute);
  if (buffer.includes(0)) return fail(`${displayPath} looks like a binary file`);
  return buffer.toString("utf8");
}

// ---------------------------------------------------------------- list_files

const listSchema = z
  .object({
    path: z.string().max(1000).default(".").describe("Directory relative to the workspace root. Defaults to the root."),
    pattern: z
      .string()
      .max(500)
      .optional()
      .describe(
        'Optional glob filter for files, relative to `path`, for example "**/*.ts", "src/*.tsx" or "*.{js,json}". ' +
          "Supports **, *, ? and {a,b}. A pattern without / matches file names at any depth.",
      ),
    max_results: z.number().int().min(1).max(1000).default(300).describe("Maximum entries to return (1-1000)."),
  })
  .strict();

export const listFilesTool: ToolDefinition<typeof listSchema> = {
  name: "list_files",
  title: "List files",
  description:
    "List files and directories in the workspace recursively, optionally filtered by a glob pattern. " +
    "Use it to explore project structure or find files by name before reading them. " +
    "Paths are relative to the workspace root; directories end with / when no pattern is given. " +
    "Dependency and build folders such as node_modules, .git, .next and dist are skipped.",
  schema: listSchema,
  defaultPolicy: "auto",
  risk: "read",
  available: always,
  summarize: (input) =>
    input.pattern ? `List ${input.pattern} in ${where(input.path)}` : `List files in ${where(input.path)}`,
  async run(input, ctx) {
    const display = input.path;
    try {
      const base = await resolveWorkspacePath(display);
      const stat = await fs.stat(base);
      if (!stat.isDirectory()) return fail(`${display} is a file, not a directory. Use read_file to read it.`);

      const matcher = input.pattern ? globToRegExp(input.pattern) : null;
      const max = input.max_results;
      const results: string[] = [];
      let truncated = false;
      for await (const entry of walkWorkspace(base, ctx.signal)) {
        const relative = toWorkspaceRelative(entry.path);
        if (matcher) {
          if (entry.isDirectory) continue;
          const fromBase = path.relative(base, entry.path).split(path.sep).join("/");
          // Accept patterns written relative to `path` or to the workspace root.
          if (!matcher.test(fromBase) && !matcher.test(relative)) continue;
        }
        if (results.length === max) {
          truncated = true;
          break;
        }
        results.push(entry.isDirectory ? `${relative}/` : relative);
      }
      if (results.length === 0) {
        return ok(matcher ? `No files match ${input.pattern} in ${where(display)}` : `${where(display)} is empty`);
      }
      const note = truncated ? `\n[showing the first ${max} entries; narrow the path or pattern to see more]` : "";
      return ok(results.join("\n") + note);
    } catch (error) {
      return describeError(error, display);
    }
  },
};

// ---------------------------------------------------------------- read_file

const readSchema = z
  .object({
    path: z.string().min(1).max(1000).describe("File path relative to the workspace root."),
    offset: z.number().int().min(1).optional().describe("1-based line number to start from. Defaults to 1."),
    limit: z.number().int().min(1).max(2000).default(400).describe("Maximum number of lines to return (1-2000)."),
  })
  .strict();

export const readFileTool: ToolDefinition<typeof readSchema> = {
  name: "read_file",
  title: "Read file",
  description:
    "Read a text file from the workspace. Lines are returned numbered (line number, tab, text). " +
    "Large files are returned in pages: use offset and limit to read further. " +
    "Always read a file before editing it. Binary files and files over 5 MB are refused.",
  schema: readSchema,
  defaultPolicy: "auto",
  risk: "read",
  available: always,
  summarize: (input) => {
    const start = input.offset ?? 1;
    return `Read ${input.path} (lines ${start}-${start + input.limit - 1})`;
  },
  async run(input) {
    try {
      const absolute = await resolveWorkspacePath(input.path);
      const text = await readText(absolute, input.path);
      if (typeof text !== "string") return text;

      const lines = splitLines(text);
      if (lines.length === 0) return ok(`${input.path} is empty`);
      const start = input.offset ?? 1;
      if (start > lines.length) {
        return fail(`offset ${start} is past the end of ${input.path} (${lines.length} lines)`);
      }
      const last = Math.min(lines.length, start + input.limit - 1);

      // Stop at whole lines before the output cap so the footer can say exactly where to resume.
      const budget = MAX_TOOL_OUTPUT_CHARS - 200;
      const out: string[] = [];
      let used = 0;
      let end = start - 1;
      for (let n = start; n <= last; n++) {
        let line = lines[n - 1];
        if (line.length > MAX_LINE_CHARS) line = `${line.slice(0, MAX_LINE_CHARS)}... [line truncated]`;
        const formatted = `${String(n).padStart(6)}\t${line}`;
        if (used + formatted.length + 1 > budget && out.length > 0) break;
        out.push(formatted);
        used += formatted.length + 1;
        end = n;
      }
      let footer = "";
      if (start > 1 || end < lines.length) {
        footer = `\n[lines ${start}-${end} of ${lines.length}`;
        footer += end < lines.length ? `; continue with offset ${end + 1}]` : "]";
      }
      return ok(out.join("\n") + footer);
    } catch (error) {
      return describeError(error, input.path);
    }
  },
};

// ---------------------------------------------------------------- search_files

const searchSchema = z
  .object({
    pattern: z.string().min(1).max(500).describe("JavaScript regular expression source, for example \"useState\\\\(\"."),
    path: z.string().max(1000).default(".").describe("File or directory to search, relative to the workspace root."),
    glob: z.string().max(500).optional().describe('Only search files matching this glob, for example "**/*.ts".'),
    case_insensitive: z.boolean().optional().describe("Match regardless of letter case."),
    max_results: z.number().int().min(1).max(500).default(100).describe("Maximum matching lines to return (1-500)."),
  })
  .strict();

// Runs every line of one file through the regex inside a vm context. The vm timeout is the only
// way to interrupt a catastrophically backtracking regex (for example `(a+)+$`) from the same
// thread; without it a single bad pattern would block the server's event loop indefinitely.
const matchScript = new vm.Script(
  "hits = []; for (let i = 0; i < lines.length; i++) { if (re.test(lines[i])) hits.push(i); } hits",
);

export const searchFilesTool: ToolDefinition<typeof searchSchema> = {
  name: "search_files",
  title: "Search files",
  description:
    "Search file contents in the workspace with a JavaScript regular expression, like grep. " +
    "Returns matching lines as path:line: text. Use it to find definitions, usages or strings across the project. " +
    "Skips dependency and build folders, binary files and files over 1 MB. Narrow with path or glob for speed.",
  schema: searchSchema,
  defaultPolicy: "auto",
  risk: "read",
  available: always,
  summarize: (input) => {
    const pattern = input.pattern.length > 80 ? `${input.pattern.slice(0, 80)}...` : input.pattern;
    return `Search for /${pattern}/ in ${where(input.path)}`;
  },
  async run(input, ctx) {
    const display = input.path;
    let regex: RegExp;
    try {
      regex = new RegExp(input.pattern, input.case_insensitive ? "i" : "");
    } catch (error) {
      return fail(`Invalid regular expression: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      const base = await resolveWorkspacePath(display);
      const stat = await fs.stat(base);
      const matcher = input.glob ? globToRegExp(input.glob) : null;
      const max = input.max_results;
      const deadline = Date.now() + SEARCH_BUDGET_MS;
      const context = vm.createContext({ re: regex, lines: [] as string[], hits: [] });

      const files: AsyncIterable<{ path: string; isDirectory: boolean }> = stat.isDirectory()
        ? walkWorkspace(base, ctx.signal)
        : (async function* () {
            yield { path: base, isDirectory: false };
          })();

      const results: string[] = [];
      let truncated = false;
      for await (const entry of files) {
        if (entry.isDirectory) continue;
        const relative = toWorkspaceRelative(entry.path);
        if (matcher && stat.isDirectory()) {
          const fromBase = path.relative(base, entry.path).split(path.sep).join("/");
          if (!matcher.test(fromBase) && !matcher.test(relative)) continue;
        }
        const fileStat = await fs.stat(entry.path).catch(() => null);
        if (!fileStat?.isFile() || fileStat.size > MAX_SEARCH_FILE_BYTES) continue;
        const buffer = await fs.readFile(entry.path).catch(() => null);
        if (!buffer || buffer.includes(0)) continue;

        const lines = splitLines(buffer.toString("utf8"));
        context.lines = lines;
        const remaining = deadline - Date.now();
        let hits: number[];
        try {
          if (remaining <= 0) throw new Error("budget");
          hits = matchScript.runInContext(context, { timeout: remaining });
        } catch {
          return fail(
            `Search stopped after ${SEARCH_BUDGET_MS / 1000}s. Simplify the pattern or narrow the path or glob.` +
              (results.length ? `\nPartial results:\n${results.join("\n")}` : ""),
          );
        }
        for (const index of hits) {
          if (results.length === max) {
            truncated = true;
            break;
          }
          const text = lines[index].trim();
          const shown = text.length > MAX_MATCH_LINE_CHARS ? `${text.slice(0, MAX_MATCH_LINE_CHARS)}...` : text;
          results.push(`${relative}:${index + 1}: ${shown}`);
        }
        if (truncated || ctx.signal.aborted) break;
      }
      if (results.length === 0) return ok(`No matches for /${input.pattern}/ in ${where(display)}`);
      const note = truncated ? `\n[stopped at ${max} matches; narrow the search to see more]` : "";
      return ok(results.join("\n") + note);
    } catch (error) {
      return describeError(error, display);
    }
  },
};

// ---------------------------------------------------------------- write_file

const writeSchema = z
  .object({
    path: z.string().min(1).max(1000).describe("File path relative to the workspace root. Parent folders are created."),
    content: z.string().max(2_000_000).describe("The complete new file content."),
  })
  .strict();

export const writeFileTool: ToolDefinition<typeof writeSchema> = {
  name: "write_file",
  title: "Write file",
  description:
    "Create a new file or completely replace an existing one with the given content. " +
    "Prefer edit_file for changing part of an existing file; use write_file for new files or full rewrites. " +
    "Read an existing file before overwriting it. Files inside .git cannot be written.",
  schema: writeSchema,
  defaultPolicy: "ask",
  risk: "write",
  available: always,
  summarize: (input) => `Write ${formatBytes(Buffer.byteLength(input.content, "utf8"))} to ${input.path}`,
  async run(input) {
    try {
      const absolute = await resolveWritablePath(input.path);
      const existing = await fs.stat(absolute).catch(() => null);
      if (existing?.isDirectory()) return fail(`${input.path} is a directory`);
      if (existing && !existing.isFile()) return fail(`${input.path} is not a regular file`);
      await fs.mkdir(path.dirname(absolute), { recursive: true });
      await fs.writeFile(absolute, input.content, "utf8");
      const size = formatBytes(Buffer.byteLength(input.content, "utf8"));
      const lines = countLines(input.content);
      const action = existing ? "overwrote existing file" : "created new file";
      return ok(`Wrote ${size} (${lines} ${lines === 1 ? "line" : "lines"}) to ${input.path} (${action})`);
    } catch (error) {
      return describeError(error, input.path);
    }
  },
};

// ---------------------------------------------------------------- edit_file

const editSchema = z
  .object({
    path: z.string().min(1).max(1000).describe("File path relative to the workspace root."),
    old_string: z
      .string()
      .min(1)
      .describe("Exact text to replace, including whitespace and indentation. Must occur exactly once unless replace_all is true."),
    new_string: z.string().describe("Replacement text. Must differ from old_string."),
    replace_all: z.boolean().optional().describe("Replace every occurrence instead of requiring a unique match."),
  })
  .strict();

export const editFileTool: ToolDefinition<typeof editSchema> = {
  name: "edit_file",
  title: "Edit file",
  description:
    "Replace an exact string in an existing file. Read the file first: old_string must match the file exactly " +
    "(including whitespace and indentation, without the line-number prefix from read_file) and be unique. " +
    "Include enough surrounding lines to make it unique, or set replace_all to change every occurrence. " +
    "Use write_file to create new files. Files inside .git cannot be edited.",
  schema: editSchema,
  defaultPolicy: "ask",
  risk: "write",
  available: always,
  summarize: (input) => `Edit ${input.path}`,
  async run(input) {
    try {
      const absolute = await resolveWritablePath(input.path);
      const content = await readText(absolute, input.path).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return fail(`${input.path} does not exist. Use write_file to create it.`);
        }
        throw error;
      });
      if (typeof content !== "string") return content;

      // Models usually send LF. Match and write using the file's own line endings so an edit does
      // not silently convert a CRLF file (or the edited region of it).
      const crlf = content.includes("\r\n");
      const toFileEndings = (s: string) => (crlf ? s.replace(/\r?\n/g, "\r\n") : s.replace(/\r\n/g, "\n"));
      const oldString = toFileEndings(input.old_string);
      const newString = toFileEndings(input.new_string);
      if (oldString === newString) return fail("old_string and new_string are identical; nothing to change");

      const parts = content.split(oldString);
      const count = parts.length - 1;
      if (count === 0) {
        return fail(
          `old_string was not found in ${input.path}. Read the file again and copy the exact text, including whitespace.`,
        );
      }
      if (count > 1 && !input.replace_all) {
        return fail(
          `old_string matches ${count} times in ${input.path}. Add surrounding context to make it unique, ` +
            "or set replace_all to true.",
        );
      }
      // Here the match is unique or replace_all is set, so joining replaces exactly what was asked.
      // Split/join instead of String.replace, which would expand `$&`, `$1` and similar in new_string.
      await fs.writeFile(absolute, parts.join(newString), "utf8");
      return ok(`Edited ${input.path}: replaced ${count} ${count === 1 ? "occurrence" : "occurrences"}`);
    } catch (error) {
      return describeError(error, input.path);
    }
  },
};
