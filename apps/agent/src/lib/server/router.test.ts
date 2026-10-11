// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as getRouter, PUT as putRouter } from "@/app/api/router/route";
import type { RouterConfig } from "@/lib/contract";
import * as db from "./db";
import { chooseModel, fallbackFor, getRouterConfig, saveRouterConfig, subagentModel } from "./router";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "tatvam-router-"));
  vi.stubEnv("DATA_DIR", dir);
});
afterEach(() => {
  db.closeDb();
  rmSync(dir, { recursive: true, force: true });
});

const main = { provider: "gpu" as const, model: "big" };
const canary = { provider: "gpu" as const, model: "big-ft-v2" };
const requested = { provider: "ollama" as const, model: "small" };
const config = (overrides: Partial<RouterConfig> = {}): RouterConfig => ({
  enabled: true,
  main,
  subagent: null,
  judge: null,
  fallback: null,
  canary: null,
  ...overrides,
});

describe("chooseModel", () => {
  it("uses the requested model unless the router is enabled, configured and asked for", () => {
    expect(chooseModel(config(), { requested, existing: null, useRouter: false })).toEqual(requested);
    expect(chooseModel(config({ enabled: false }), { requested, existing: null, useRouter: true })).toEqual(requested);
    expect(chooseModel(config({ main: null }), { requested, existing: null, useRouter: true })).toEqual(requested);
    expect(chooseModel(config(), { requested, existing: null, useRouter: true })).toEqual(main);
  });

  it("sends the canary share of new conversations to the canary and keeps conversations sticky", () => {
    const withCanary = config({ canary: { model: canary, percent: 10 } });
    expect(chooseModel(withCanary, { requested, existing: null, useRouter: true }, () => 0.05)).toEqual(canary);
    expect(chooseModel(withCanary, { requested, existing: null, useRouter: true }, () => 0.5)).toEqual(main);
    expect(chooseModel(withCanary, { requested, existing: canary, useRouter: true }, () => 0.99)).toEqual(canary);
  });
});

describe("sub-agent and fallback models", () => {
  it("routes sub-agents to their own model only when configured", () => {
    const small = { provider: "ollama" as const, model: "fast" };
    expect(subagentModel(config({ subagent: small }), main)).toEqual(small);
    expect(subagentModel(config({ enabled: false, subagent: small }), main)).toEqual(main);
    expect(subagentModel(config(), main)).toEqual(main);
  });

  it("offers a fallback only when it differs from the failing model", () => {
    const fallback = { provider: "ollama" as const, model: "backup" };
    expect(fallbackFor(config({ fallback }), main)).toEqual(fallback);
    expect(fallbackFor(config({ fallback }), fallback)).toBeNull();
    expect(fallbackFor(config({ enabled: false, fallback }), main)).toBeNull();
  });
});

describe("stored router settings", () => {
  it("defaults to disabled and ignores corrupt stored settings", () => {
    expect(getRouterConfig().enabled).toBe(false);
    db.setSetting("router", { enabled: true, main: { provider: "openai", model: "x" } });
    expect(getRouterConfig().enabled).toBe(false);
    saveRouterConfig(config());
    expect(getRouterConfig()).toEqual(config());
  });

  it("saves through the API and refuses to enable without a main model", async () => {
    const put = (body: unknown) =>
      putRouter(
        new Request("http://127.0.0.1:3000/api/router", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
    expect((await put(config({ main: null }))).status).toBe(400);
    expect((await put({ ...config(), extra: true })).status).toBe(400);
    expect((await put(config())).status).toBe(200);
    expect(await (await getRouter(new Request("http://127.0.0.1:3000/api/router"))).json()).toEqual(config());
  });
});
