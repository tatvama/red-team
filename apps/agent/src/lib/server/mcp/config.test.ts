// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { describeTarget, loadMcpConfig, parseMcpConfig, resolveServer } from "./config";

const valid = {
  mcpServers: {
    files: { command: "node", args: ["server.js", "--root", "${env:FILES_ROOT}"], env: { ROOT: "/data" }, cwd: "srv", timeoutSeconds: 30 },
    remote: {
      url: "https://user:pw@example.com/mcp?key=secret#frag",
      headers: { Authorization: "Bearer ${env:REMOTE_TOKEN}" },
      disabled: true,
    },
  },
};

describe("parseMcpConfig", () => {
  it("accepts the Claude Desktop format", () => {
    const config = parseMcpConfig(JSON.stringify(valid));
    expect(config.error).toBeNull();
    expect(Object.keys(config.servers)).toEqual(["files", "remote"]);
    expect(config.servers.remote).toMatchObject({ disabled: true });
  });

  it("treats a file without mcpServers as no servers", () => {
    expect(parseMcpConfig("{}")).toEqual({ servers: {}, error: null });
  });

  it("reports invalid JSON without throwing", () => {
    const config = parseMcpConfig("{ not json");
    expect(config.servers).toEqual({});
    expect(config.error).toMatch(/not valid JSON/);
  });

  it.each([
    [{ servers: {} }, /Unrecognized key/],
    [{ mcpServers: { "bad name!": { command: "node" } } }, /Server names/],
    [{ mcpServers: { a: { command: "node", shell: true } } }, /mcpServers\.a.*Unrecognized key/],
    [{ mcpServers: { a: { url: "https://x.example", command: "node" } } }, /Unrecognized key/],
    [{ mcpServers: { a: { url: "not a url" } } }, /full URL/],
    [{ mcpServers: { a: { url: "https://x.example", headers: { "Mcp-Session-Id": "x" } } } }, /set by Tatvam/],
    [{ mcpServers: { a: { command: "node", timeoutSeconds: 0 } } }, /timeoutSeconds/],
    [{ mcpServers: { a: { args: [] } } }, /command/],
  ])("rejects an invalid shape: %j", (input, message) => {
    const config = parseMcpConfig(JSON.stringify(input));
    expect(config.servers).toEqual({});
    expect(config.error).toMatch(message);
  });
});

describe("loadMcpConfig", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "tatvam-mcp-config-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("means no servers when the file is missing", () => {
    expect(loadMcpConfig(path.join(dir, "missing.json"))).toEqual({ servers: {}, error: null });
  });

  it("reads a file with a byte order mark", () => {
    const file = path.join(dir, "mcp.json");
    writeFileSync(file, `﻿${JSON.stringify(valid)}`);
    expect(loadMcpConfig(file).error).toBeNull();
  });

  it("reports a directory instead of a file as an error", () => {
    expect(loadMcpConfig(dir).error).toMatch(/could not be read/);
  });
});

describe("resolveServer", () => {
  const { servers } = parseMcpConfig(JSON.stringify(valid));

  it("substitutes ${env:NAME} in args, env and headers, and resolves cwd against the config folder", () => {
    const base = path.resolve("/configs");
    const stdio = resolveServer(servers.files, { FILES_ROOT: "/srv/files" }, base);
    expect(stdio).toEqual({
      transport: "stdio",
      command: "node",
      args: ["server.js", "--root", "/srv/files"],
      env: { ROOT: "/data" },
      cwd: path.join(base, "srv"),
      timeoutMs: 30_000,
    });
    const http = resolveServer(servers.remote, { REMOTE_TOKEN: "t0ken" }, base);
    expect(http).toMatchObject({ transport: "http", headers: { Authorization: "Bearer t0ken" }, timeoutMs: 60_000 });
  });

  it("names missing environment variables", () => {
    expect(() => resolveServer(servers.files, {}, "/")).toThrow(/FILES_ROOT/);
    expect(() => resolveServer(servers.remote, {}, "/")).toThrow(/REMOTE_TOKEN/);
  });

  it("refuses header values with line breaks", () => {
    expect(() => resolveServer(servers.remote, { REMOTE_TOKEN: "a\r\nX-Evil: 1" }, "/")).toThrow(/line break/);
  });
});

describe("describeTarget", () => {
  const { servers } = parseMcpConfig(JSON.stringify(valid));

  it("shows the command with unsubstituted args", () => {
    expect(describeTarget(servers.files)).toBe("node server.js --root ${env:FILES_ROOT}");
  });

  it("strips credentials, query and fragment from URLs and never shows headers", () => {
    const target = describeTarget(servers.remote);
    expect(target).toBe("https://example.com/mcp");
    expect(target).not.toMatch(/secret|pw|Bearer/);
  });
});
