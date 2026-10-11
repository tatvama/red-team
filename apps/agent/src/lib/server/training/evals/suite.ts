import "server-only";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { evalCategorySchema, permissionModeSchema, toolNamePattern, type EvalSuiteView } from "@/lib/contract";

// Evaluation suites are JSON files in `evals/suites`, with fixture folders in `evals/fixtures`.
// They are operator-authored server files; the browser only picks a suite and task ids.

const idSchema = z.string().regex(/^[a-z0-9-]{1,60}$/, "Use 1 to 60 lowercase letters, digits or dashes");
const fixtureNameSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,59}$/, "Fixture names are lowercase folder names");

/** True for a plain relative path that cannot leave the task folder lexically. */
export function isSafeRelativePath(value: string): boolean {
  if (!value.trim() || value.includes("\0")) return false;
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value) || /^[a-zA-Z]:/.test(value)) return false;
  return !value.split(/[\\/]/).some((segment) => segment === "..");
}

const relativePathSchema = z
  .string()
  .min(1)
  .max(300)
  .refine(isSafeRelativePath, "Use a path relative to the task folder, without `..`");

/** Regex flags without `g` and `y`, which would make `test()` stateful. */
const flagsSchema = z.string().regex(/^[imsu]{0,4}$/, "Allowed regex flags: i, m, s, u");

function validRegex(value: { pattern: string; flags?: string }): boolean {
  try {
    new RegExp(value.pattern, value.flags ?? "");
    return true;
  } catch {
    return false;
  }
}

const patternFields = { pattern: z.string().min(1).max(2000), flags: flagsSchema.optional() };
const toolName = z.string().regex(toolNamePattern);

export const evalCheckSchema = z.discriminatedUnion("type", [
  /** The file exists and contains `text` exactly (case-sensitive). */
  z.object({ type: z.literal("file_contains"), path: relativePathSchema, text: z.string().min(1).max(5000) }).strict(),
  /** The file exists and matches the regular expression. */
  z
    .object({ type: z.literal("file_matches"), path: relativePathSchema, ...patternFields })
    .strict()
    .refine(validRegex, "Invalid regular expression"),
  /** Nothing exists at the path. */
  z.object({ type: z.literal("file_absent"), path: relativePathSchema }).strict(),
  /** The file has the same bytes as in the fixture. */
  z.object({ type: z.literal("file_unchanged"), path: relativePathSchema }).strict(),
  /** The tool ran successfully at least `minTimes` times (default 1). */
  z.object({ type: z.literal("tool_called"), name: toolName, minTimes: z.number().int().min(1).max(100).optional() }).strict(),
  /** The model never attempted to call the tool, successful or not. */
  z.object({ type: z.literal("tool_not_called"), name: toolName }).strict(),
  /** The final reply contains `text`; case-insensitive unless `caseSensitive` is true. */
  z
    .object({ type: z.literal("answer_contains"), text: z.string().min(1).max(5000), caseSensitive: z.boolean().optional() })
    .strict(),
  z
    .object({ type: z.literal("answer_matches"), ...patternFields })
    .strict()
    .refine(validRegex, "Invalid regular expression"),
  /** The whole final reply is one JSON object with these top-level keys. */
  z
    .object({ type: z.literal("answer_json"), requiredKeys: z.array(z.string().min(1).max(200)).min(1).max(50) })
    .strict(),
  /** At most `max` assistant turns. */
  z.object({ type: z.literal("max_steps"), max: z.number().int().min(1).max(200) }).strict(),
  /** No calls to unknown tools, with invalid JSON, or with arguments that failed validation. */
  z.object({ type: z.literal("no_invalid_tool_calls") }).strict(),
  /** Graded by the judge model; passes when its score is at least `minScore` (default 0.7). */
  z
    .object({ type: z.literal("judge"), rubric: z.string().trim().min(1).max(4000), minScore: z.number().min(0).max(1).optional() })
    .strict(),
]);
export type EvalCheck = z.infer<typeof evalCheckSchema>;

export const DEFAULT_TIMEOUT_SECONDS = 300;

export const evalTaskSchema = z
  .object({
    id: idSchema,
    title: z.string().trim().min(1).max(120),
    category: evalCategorySchema,
    prompt: z.string().trim().min(1).max(8000),
    /** A folder under `evals/fixtures`, copied into a fresh temp folder for each run of the task. */
    fixture: fixtureNameSchema.optional(),
    /** Defaults to `full_auto`, which is safe for files because the task works in a throwaway copy. */
    permissionMode: permissionModeSchema.default("full_auto"),
    timeoutSeconds: z.number().int().min(1).max(3600).default(DEFAULT_TIMEOUT_SECONDS),
    checks: z.array(evalCheckSchema).min(1).max(50),
  })
  .strict()
  .superRefine((task, ctx) => {
    if (!task.fixture && task.checks.some((check) => check.type === "file_unchanged"))
      ctx.addIssue({ code: "custom", message: "file_unchanged needs a fixture to compare with", path: ["checks"] });
  });
export type EvalTask = z.infer<typeof evalTaskSchema>;

export const evalSuiteSchema = z
  .object({
    id: idSchema,
    title: z.string().trim().min(1).max(120),
    description: z.string().max(2000),
    tasks: z.array(evalTaskSchema).min(1).max(200),
  })
  .strict()
  .superRefine((suite, ctx) => {
    const seen = new Set<string>();
    suite.tasks.forEach((task, index) => {
      if (seen.has(task.id)) ctx.addIssue({ code: "custom", message: `Duplicate task id "${task.id}"`, path: ["tasks", index, "id"] });
      seen.add(task.id);
    });
  });
export type EvalSuite = z.infer<typeof evalSuiteSchema>;

/** Root of the suites and fixtures. `EVALS_DIR` overrides `<app>/evals`. */
export function evalsDir(): string {
  const configured = process.env.EVALS_DIR?.trim();
  return path.resolve(/*turbopackIgnore: true*/ configured || path.join(process.cwd(), "evals"));
}

export function fixturePath(name: string): string {
  return path.join(evalsDir(), "fixtures", name);
}

/** Parses suite JSON text; throws an Error with a readable message when it is invalid. */
export function parseSuite(text: string): EvalSuite {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("The suite is not valid JSON");
  }
  const parsed = evalSuiteSchema.safeParse(value);
  if (!parsed.success) throw new Error(z.prettifyError(parsed.error));
  return parsed.data;
}

/** Problems with files a valid suite refers to: missing fixtures and missing `file_unchanged` originals. */
export function suiteFileProblems(suite: EvalSuite): string[] {
  const problems: string[] = [];
  for (const task of suite.tasks) {
    if (!task.fixture) continue;
    const root = fixturePath(task.fixture);
    if (!existsSync(root) || !statSync(root).isDirectory()) {
      problems.push(`Task "${task.id}" names a missing fixture "${task.fixture}"`);
      continue;
    }
    for (const check of task.checks)
      if (check.type === "file_unchanged" && !existsSync(path.join(root, check.path)))
        problems.push(`Task "${task.id}" checks "${check.path}", which is not in fixture "${task.fixture}"`);
  }
  return problems;
}

/** Every suite file, valid or not. Invalid suites are reported in `problems` and left out. */
export function loadSuites(): { suites: EvalSuite[]; problems: string[] } {
  const dir = path.join(evalsDir(), "suites");
  let files: string[];
  try {
    files = readdirSync(dir).filter((name) => name.endsWith(".json")).sort();
  } catch {
    return { suites: [], problems: [`No suites folder at ${dir}`] };
  }
  const suites: EvalSuite[] = [];
  const problems: string[] = [];
  for (const file of files) {
    try {
      const suite = parseSuite(readFileSync(path.join(dir, file), "utf8"));
      const fileProblems = suiteFileProblems(suite);
      if (fileProblems.length) throw new Error(fileProblems.join("; "));
      if (suites.some((existing) => existing.id === suite.id)) throw new Error(`Suite id "${suite.id}" is already used`);
      suites.push(suite);
    } catch (error) {
      problems.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { suites, problems };
}

export function listSuites(): EvalSuite[] {
  const { suites, problems } = loadSuites();
  for (const problem of problems) console.warn(`[evals] Skipped suite ${problem}`);
  return suites;
}

export function getSuite(id: string): EvalSuite | null {
  return listSuites().find((suite) => suite.id === id) ?? null;
}

export function suiteView(suite: EvalSuite): EvalSuiteView {
  return {
    id: suite.id,
    title: suite.title,
    description: suite.description,
    tasks: suite.tasks.map((task) => ({ id: task.id, title: task.title, category: task.category })),
  };
}
