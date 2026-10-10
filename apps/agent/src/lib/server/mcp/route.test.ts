// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/mcp/[name]/route";
import type { McpServerView } from "@/lib/contract";
import { closeDb, getSetting } from "../db";
import { shutdownMcp } from "./manager";

// POST /api/mcp/[name] through the real route handler.

const fixture = fileURLToPath(new URL("./fixtures/fake-server.mjs", import.meta.url));
const base = "http://127.0.0.1:3000";
let dir: string;

const post = (name: string, body: unknown, headers: Record<string, string> = {}) =>
  POST(
    new Request(`${base}/api/mcp/${name}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ name }) },
  );

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "tatvam-mcp-route-"));
  const configFile = path.join(dir, "mcp.json");
  vi.stubEnv("DATA_DIR", dir);
  vi.stubEnv("MCP_CONFIG", configFile);
  writeFileSync(
    configFile,
    JSON.stringify({
      mcpServers: {
        fake: { command: process.execPath, args: [fixture] },
        off: { command: process.execPath, args: [fixture], disabled: true },
      },
    }),
  );
});

afterEach(async () => {
  await shutdownMcp();
  closeDb();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("POST /api/mcp/[name]", () => {
  it("returns 404 for a server that is not in the config", async () => {
    const response = await post("unknown", { action: "restart" });
    expect(response.status).toBe(404);
    expect((await post("bad%20name", { action: "enable" })).status).toBe(404);
  });

  it("returns 400 for an invalid body", async () => {
    expect((await post("fake", { action: "explode" })).status).toBe(400);
    expect((await post("fake", { action: "enable", extra: true })).status).toBe(400);
    expect((await post("fake", "{ not json")).status).toBe(400);
  });

  it("disables and enables a server and persists the choice", async () => {
    const disabled = await post("fake", { action: "disable" });
    expect(disabled.status).toBe(200);
    expect(disabled.headers.get("cache-control")).toBe("no-store");
    expect((await disabled.json()) as McpServerView).toMatchObject({ name: "fake", enabled: false, status: "disabled" });
    expect(getSetting("mcpDisabled", [])).toEqual(["fake"]);

    const enabled = await post("fake", { action: "enable" });
    expect(enabled.status).toBe(200);
    const view = (await enabled.json()) as McpServerView;
    expect(view).toMatchObject({ name: "fake", enabled: true, status: "connected", transport: "stdio" });
    expect(view.tools.map((tool) => tool.name)).toContain("mcp_fake_echo");
    expect(getSetting("mcpDisabled", ["x"])).toEqual([]);
  });

  it("restarts a server", async () => {
    const response = await post("fake", { action: "restart" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ name: "fake", status: "connected" });
  });

  it("cannot enable a server that the config file disables", async () => {
    const response = await post("off", { action: "enable" });
    expect(response.status).toBe(409);
  });

  it("refuses cross-origin requests", async () => {
    const response = await post("fake", { action: "disable" }, { origin: "https://evil.example" });
    expect(response.status).toBe(403);
    expect(getSetting("mcpDisabled", [])).toEqual([]);
  });
});
