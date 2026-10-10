// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { globToRegExp, hasGitSegment, isInside, resolveWorkspacePath, toWorkspaceRelative, walkWorkspace } from "./workspace-path";

let root: string;
let workspace: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "tatvam-ws-"));
  workspace = path.join(root, "workspace");
  vi.stubEnv("WORKSPACE_DIR", workspace);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("resolveWorkspacePath", () => {
  it("resolves relative paths inside the workspace and creates the workspace", async () => {
    await expect(resolveWorkspacePath("src/app.ts")).resolves.toBe(path.join(workspace, "src", "app.ts"));
    await expect(resolveWorkspacePath(".")).resolves.toBe(workspace);
    await expect(resolveWorkspacePath("a/../b.txt")).resolves.toBe(path.join(workspace, "b.txt"));
    expect((await fs.stat(workspace)).isDirectory()).toBe(true);
  });

  it.each([
    ["", "empty"],
    ["   ", "empty"],
    ["a\0b", "NUL"],
    ["../x", "escapes"],
    ["src/../../x", "escapes"],
    ["..", "escapes"],
    ["/etc/passwd", "relative"],
    ["\\Windows\\System32", "relative"],
    ["C:\\x", "relative"],
    ["C:x", "relative"],
    ["c:/x", "relative"],
    ["\\\\server\\share\\x", "relative"],
    ["//server/share/x", "relative"],
    ["\\\\?\\C:\\x", "relative"],
  ])("rejects %j", async (input, message) => {
    await expect(resolveWorkspacePath(input)).rejects.toThrow(message);
  });

  it.runIf(process.platform === "win32")("rejects Windows device names and alternate data streams", async () => {
    await expect(resolveWorkspacePath("NUL")).rejects.toThrow("device name");
    await expect(resolveWorkspacePath("src/com1.txt")).rejects.toThrow("device name");
    await expect(resolveWorkspacePath("notes.txt:hidden")).rejects.toThrow("':'");
  });

  it("rejects symlink or junction escapes but allows links that stay inside", async (ctx) => {
    const outside = path.join(root, "outside");
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(outside, "secret.txt"), "secret");
    await fs.mkdir(path.join(workspace, "inner"), { recursive: true });
    // Junctions need no special privileges on Windows; symlinks may need developer mode.
    const type = process.platform === "win32" ? "junction" : "dir";
    try {
      await fs.symlink(outside, path.join(workspace, "escape"), type);
      await fs.symlink(path.join(workspace, "inner"), path.join(workspace, "alias"), type);
    } catch {
      ctx.skip();
    }
    await expect(resolveWorkspacePath("escape/secret.txt")).rejects.toThrow("through a link");
    await expect(resolveWorkspacePath("escape/new-file.txt")).rejects.toThrow("through a link");
    await expect(resolveWorkspacePath("escape")).rejects.toThrow("through a link");
    await expect(resolveWorkspacePath("alias/file.txt")).resolves.toBe(path.join(workspace, "alias", "file.txt"));
  });

  it("rejects writing through a dangling link", async (ctx) => {
    await fs.mkdir(workspace, { recursive: true });
    try {
      const type = process.platform === "win32" ? "junction" : "dir";
      await fs.symlink(path.join(root, "not-yet"), path.join(workspace, "dangling"), type);
    } catch {
      ctx.skip();
    }
    await expect(resolveWorkspacePath("dangling")).rejects.toThrow("broken link");
    await expect(resolveWorkspacePath("dangling/new.txt")).rejects.toThrow("broken link");
  });
});

describe("helpers", () => {
  it("formats workspace-relative paths with forward slashes", () => {
    expect(toWorkspaceRelative(path.join(workspace, "src", "lib", "a.ts"))).toBe("src/lib/a.ts");
    expect(toWorkspaceRelative(workspace)).toBe(".");
  });

  it("checks containment without being fooled by shared prefixes", () => {
    const base = path.resolve("/data/ws");
    expect(isInside(base, path.join(base, "a"))).toBe(true);
    expect(isInside(base, base)).toBe(true);
    expect(isInside(base, path.resolve("/data/ws-other/a"))).toBe(false);
    expect(isInside(base, path.resolve("/data"))).toBe(false);
  });

  it("translates globs", () => {
    const ts = globToRegExp("**/*.ts");
    expect(ts.test("a.ts")).toBe(true);
    expect(ts.test("src/lib/a.ts")).toBe(true);
    expect(ts.test("src/a.tsx")).toBe(false);
    const src = globToRegExp("src/*.tsx");
    expect(src.test("src/page.tsx")).toBe(true);
    expect(src.test("src/app/page.tsx")).toBe(false);
    const braces = globToRegExp("*.{js,json}");
    expect(braces.test("deep/package.json")).toBe(true);
    expect(braces.test("index.js")).toBe(true);
    expect(braces.test("index.ts")).toBe(false);
    expect(globToRegExp("file?.md").test("file1.md")).toBe(true);
    expect(globToRegExp("file?.md").test("file10.md")).toBe(false);
    expect(globToRegExp("docs/**").test("docs/a/b/c.md")).toBe(true);
    expect(globToRegExp("a+b(1).txt").test("a+b(1).txt")).toBe(true);
  });

  it("walks in name order and skips ignored directories", async () => {
    await fs.mkdir(path.join(workspace, "node_modules", "pkg"), { recursive: true });
    await fs.mkdir(path.join(workspace, "src"), { recursive: true });
    await fs.writeFile(path.join(workspace, "node_modules", "pkg", "index.js"), "");
    await fs.writeFile(path.join(workspace, "src", "b.ts"), "");
    await fs.writeFile(path.join(workspace, "a.ts"), "");
    const seen: string[] = [];
    for await (const entry of walkWorkspace(workspace)) seen.push(toWorkspaceRelative(entry.path));
    expect(seen).toEqual(["a.ts", "src", "src/b.ts"]);
  });
});

describe("hasGitSegment", () => {
  it("finds .git segments in any letter case and Windows alias", () => {
    for (const value of [".git", ".git/config", "a/.GIT/b", "a\\.Git\\b",".git./x", ".git /x", "GIT~1/config"]) {
      expect(hasGitSegment(value)).toBe(true);
    }
    for (const value of [".gitignore", ".github/workflows/ci.yml", "src/git.ts", "a.git/b", "my.git"]) {
      expect(hasGitSegment(value)).toBe(false);
    }
  });
});
