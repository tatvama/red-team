// @vitest-environment node
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { evalCategorySchema } from "@/lib/contract";
import { writeSuite } from "../test-helpers";
import { evalsDir, fixturePath, getSuite, loadSuites, parseSuite, suiteFileProblems, suiteView } from "./suite";

const task = (overrides: Record<string, unknown> = {}) => ({
  id: "task-one",
  title: "Task one",
  category: "coding",
  prompt: "Do the thing.",
  checks: [{ type: "answer_contains", text: "done" }],
  ...overrides,
});
const suite = (overrides: Record<string, unknown> = {}) => ({
  id: "demo",
  title: "Demo",
  description: "A demo suite.",
  tasks: [task()],
  ...overrides,
});
const parse = (value: unknown) => parseSuite(JSON.stringify(value));

describe("built-in suites", () => {
  it("parses the core suite, and every fixture and original file it names exists", () => {
    const { suites, problems } = loadSuites();
    expect(problems).toEqual([]);
    const core = suites.find((item) => item.id === "core");
    expect(core).toBeDefined();
    expect(core!.tasks.length).toBeGreaterThanOrEqual(10);
    expect(new Set(core!.tasks.map((item) => item.category))).toEqual(new Set(evalCategorySchema.options));
    expect(suiteFileProblems(core!)).toEqual([]);
    for (const item of core!.tasks) {
      if (!item.fixture) continue;
      expect(statSync(fixturePath(item.fixture)).isDirectory()).toBe(true);
      for (const check of item.checks)
        if (check.type === "file_unchanged") expect(existsSync(path.join(fixturePath(item.fixture), check.path))).toBe(true);
    }
    const safety = core!.tasks.find((item) => item.category === "safety")!;
    expect(safety.permissionMode).toBe("plan");
    expect(safety.checks.map((check) => check.type)).toEqual(["tool_not_called", "tool_not_called", "file_unchanged"]);
  });

  it("finds suites under the app's evals folder by default", () => {
    expect(evalsDir()).toBe(path.join(process.cwd(), "evals"));
    expect(getSuite("core")?.title).toBe("Core agent skills");
    expect(getSuite("missing")).toBeNull();
  });

  it("shows suites without prompts or checks", () => {
    const view = suiteView(getSuite("core")!);
    expect(Object.keys(view.tasks[0]).sort()).toEqual(["category", "id", "title"]);
  });
});

describe("suite schema", () => {
  it("applies defaults", () => {
    const parsed = parse(suite());
    expect(parsed.tasks[0]).toMatchObject({ permissionMode: "full_auto", timeoutSeconds: 300 });
  });

  it("accepts every check type", () => {
    const parsed = parse(
      suite({
        tasks: [
          task({
            fixture: "app",
            checks: [
              { type: "file_contains", path: "src/a.js", text: "x" },
              { type: "file_matches", path: "src/a.js", pattern: "^x$", flags: "m" },
              { type: "file_absent", path: "tmp/out.txt" },
              { type: "file_unchanged", path: "README.md" },
              { type: "tool_called", name: "read_file", minTimes: 2 },
              { type: "tool_not_called", name: "write_file" },
              { type: "answer_contains", text: "ok", caseSensitive: true },
              { type: "answer_matches", pattern: "\\d+" },
              { type: "answer_json", requiredKeys: ["a"] },
              { type: "max_steps", max: 3 },
              { type: "no_invalid_tool_calls" },
              { type: "judge", rubric: "Is it right?", minScore: 0.5 },
            ],
          }),
        ],
      }),
    );
    expect(parsed.tasks[0].checks).toHaveLength(12);
  });

  it.each([
    ["an unknown field", suite({ extra: true })],
    ["an unknown task field", suite({ tasks: [task({ shell: "rm -rf /" })] })],
    ["an invalid suite id", suite({ id: "Bad Id" })],
    ["an unknown category", suite({ tasks: [task({ category: "exploit" })] })],
    ["an unknown check type", suite({ tasks: [task({ checks: [{ type: "run_script", path: "x.sh" }] })] })],
    ["an invalid regex", suite({ tasks: [task({ checks: [{ type: "answer_matches", pattern: "(" }] })] })],
    ["a stateful regex flag", suite({ tasks: [task({ checks: [{ type: "answer_matches", pattern: "a", flags: "g" }] })] })],
    ["a parent path", suite({ tasks: [task({ checks: [{ type: "file_absent", path: "../outside" }] })] })],
    ["an absolute path", suite({ tasks: [task({ checks: [{ type: "file_absent", path: "/etc/passwd" }] })] })],
    ["a drive path", suite({ tasks: [task({ checks: [{ type: "file_absent", path: "C:\\Windows" }] })] })],
    ["a fixture path", suite({ tasks: [task({ fixture: "../secrets" })] })],
    ["duplicate task ids", suite({ tasks: [task(), task()] })],
    ["file_unchanged without a fixture", suite({ tasks: [task({ checks: [{ type: "file_unchanged", path: "a" }] })] })],
    ["no checks", suite({ tasks: [task({ checks: [] })] })],
    ["no tasks", suite({ tasks: [] })],
    ["a bad permission mode", suite({ tasks: [task({ permissionMode: "yolo" })] })],
  ])("rejects %s", (_, value) => {
    expect(() => parse(value)).toThrow();
  });

  it("rejects text that is not JSON", () => {
    expect(() => parseSuite("{nope")).toThrow("not valid JSON");
  });
});

describe("loading suites", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "tatvam-suites-"));
    vi.stubEnv("EVALS_DIR", root);
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("skips invalid suites and reports why", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    writeSuite(root, suite({ tasks: [task({ fixture: "app", checks: [{ type: "file_unchanged", path: "a.txt" }] })] }), {
      app: { "a.txt": "a" },
    });
    writeSuite(root, suite({ id: "missing-fixture", tasks: [task({ fixture: "nowhere" })] }));
    writeSuite(root, suite({ id: "missing-original", tasks: [task({ fixture: "app", checks: [{ type: "file_unchanged", path: "b.txt" }] })] }));
    writeFileSync(path.join(root, "suites", "broken.json"), "{");
    writeFileSync(path.join(root, "suites", "zz-duplicate.json"), JSON.stringify(suite()));

    const { suites, problems } = loadSuites();
    expect(suites.map((item) => item.id)).toEqual(["demo"]);
    expect(problems.join("\n")).toMatch(/broken\.json: The suite is not valid JSON/);
    expect(problems.join("\n")).toMatch(/missing fixture "nowhere"/);
    expect(problems.join("\n")).toMatch(/"b\.txt", which is not in fixture "app"/);
    expect(problems.join("\n")).toMatch(/Suite id "demo" is already used/);

    expect(getSuite("demo")).not.toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("reports a missing suites folder", () => {
    vi.stubEnv("EVALS_DIR", path.join(root, "nothing-here"));
    expect(loadSuites()).toMatchObject({ suites: [], problems: [expect.stringMatching(/No suites folder/)] });
  });
});
