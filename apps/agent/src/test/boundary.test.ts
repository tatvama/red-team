// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Enforces the carve-out in the repository's docs/PLAN.md section 1.1: this app never imports
// assessment-platform code. Every relative import must stay inside apps/agent, and no import
// may name the platform's packages or folders.

const appRoot = path.resolve(".");
const FORBIDDEN = /(^|[/@])(services\/api|apps\/web|workers|infra\/gateway|tatvam\/contracts)(\/|$)/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" || entry.name === "fixtures" ? [] : sourceFiles(full);
    return /\.(ts|tsx|mjs)$/.test(entry.name) ? [full] : [];
  });
}

function specifiers(source: string): string[] {
  const pattern = /(?:import|export)\s[^'"]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|require\(\s*["']([^"']+)["']\s*\)/g;
  return [...source.matchAll(pattern)].map((match) => match[1] ?? match[2] ?? match[3]);
}

describe("apps/agent boundary", () => {
  const files = [...sourceFiles(path.join(appRoot, "src")), ...sourceFiles(path.join(appRoot, "scripts"))];

  it("finds the app's source files", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("never imports assessment-platform code or reaches outside the app folder", () => {
    const violations: string[] = [];
    for (const file of files) {
      for (const specifier of specifiers(readFileSync(file, "utf8"))) {
        const escapes = specifier.startsWith(".") && !path.resolve(path.dirname(file), specifier).startsWith(appRoot + path.sep);
        if (escapes || FORBIDDEN.test(specifier)) violations.push(`${path.relative(appRoot, file)} → ${specifier}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("detects a forbidden import", () => {
    expect(FORBIDDEN.test("../../services/api/app/policies")).toBe(true);
    expect(FORBIDDEN.test("@tatvam/contracts")).toBe(true);
    expect(FORBIDDEN.test("@/lib/server/tools/files")).toBe(false);
  });
});
