import "server-only";
import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

// mcp.json in the Claude Desktop format. Servers can only be added by editing this file; the
// browser can only enable, disable or restart the servers listed here.

export const serverNamePattern = /^[A-Za-z0-9_-]{1,40}$/;
export const DEFAULT_TIMEOUT_SECONDS = 60;
const MAX_CONFIG_BYTES = 1024 * 1024;
const ENV_REFERENCE = /\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g;
/** Headers the transport sets itself, or that fetch manages. */
const RESERVED_HEADERS = new Set([
  "accept",
  "content-type",
  "content-length",
  "host",
  "connection",
  "transfer-encoding",
  "mcp-session-id",
  "mcp-protocol-version",
  "last-event-id",
]);

const timeoutSeconds = z.number().int().min(1).max(3600).optional();
const disabled = z.boolean().optional();

const stdioServerSchema = z
  .object({
    command: z.string().trim().min(1).max(4096),
    args: z.array(z.string().max(32_768)).max(256).optional(),
    env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "Use letters, digits and _ in variable names"), z.string().max(32_768)).optional(),
    cwd: z.string().trim().min(1).max(4096).optional(),
    timeoutSeconds,
    disabled,
  })
  .strict();

const httpServerSchema = z
  .object({
    url: z
      .string()
      .trim()
      .max(2048)
      .refine((value) => URL.canParse(value), "Enter a full URL, for example https://example.com/mcp"),
    headers: z
      .record(
        z
          .string()
          .regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,100}$/, "Not a valid header name")
          .refine((name) => !RESERVED_HEADERS.has(name.toLowerCase()), "This header is set by Tatvam"),
        z.string().max(8192),
      )
      .optional(),
    timeoutSeconds,
    disabled,
  })
  .strict();

const configSchema = z
  .object({
    mcpServers: z
      .record(
        z.string().regex(serverNamePattern, "Server names use letters, digits, - and _ (at most 40 characters)"),
        z.unknown(),
      )
      .optional(),
  })
  .strict();

export type StdioServerConfig = z.infer<typeof stdioServerSchema>;
export type HttpServerConfig = z.infer<typeof httpServerSchema>;
export type McpServerConfig = StdioServerConfig | HttpServerConfig;
export type McpConfig = { servers: Record<string, McpServerConfig>; error: string | null };

export const isHttpConfig = (config: McpServerConfig): config is HttpServerConfig => "url" in config;

function describeIssues(error: z.ZodError, prefix: PropertyKey[] = []): string {
  const details = error.issues
    .slice(0, 3)
    .map((issue) => {
      const where = [...prefix, ...issue.path].map(String).join(".");
      // Record key failures wrap the useful message (for example the server name rule).
      const message = (issue.code === "invalid_key" && issue.issues[0]?.message) || issue.message;
      return where ? `${where}: ${message}` : message;
    })
    .join("; ");
  return `The MCP config is invalid. ${details}`;
}

/** Parses the file contents. Never throws: problems come back as `error` with no servers. */
export function parseMcpConfig(text: string): McpConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { servers: {}, error: `The MCP config is not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  const top = configSchema.safeParse(raw);
  if (!top.success) return { servers: {}, error: describeIssues(top.error) };
  const servers: Record<string, McpServerConfig> = {};
  for (const [name, value] of Object.entries(top.data.mcpServers ?? {})) {
    const isHttp = !!value && typeof value === "object" && "url" in value;
    const parsed = (isHttp ? httpServerSchema : stdioServerSchema).safeParse(value);
    if (!parsed.success) return { servers: {}, error: describeIssues(parsed.error, ["mcpServers", name]) };
    servers[name] = parsed.data;
  }
  return { servers, error: null };
}

/** A missing file means no servers; an unreadable or invalid one is reported, never thrown. */
export function loadMcpConfig(file: string): McpConfig {
  let text: string;
  try {
    const buffer = readFileSync(file);
    if (buffer.byteLength > MAX_CONFIG_BYTES) return { servers: {}, error: "The MCP config is larger than 1 MB." };
    text = buffer.toString("utf8").replace(/^﻿/, "");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { servers: {}, error: null };
    return { servers: {}, error: `The MCP config could not be read: ${(error as Error).message}` };
  }
  return parseMcpConfig(text);
}

export type ResolvedServer =
  | { transport: "stdio"; command: string; args: string[]; env: Record<string, string>; cwd?: string; timeoutMs: number }
  | { transport: "http"; url: string; headers: Record<string, string>; timeoutMs: number };

/**
 * Fills `${env:NAME}` in `env`, `headers` and `args` from the app environment, so secrets need not
 * live in the file. Throws an Error naming any variable that is not set.
 */
export function resolveServer(config: McpServerConfig, env: Record<string, string | undefined>, baseDir: string): ResolvedServer {
  const missing = new Set<string>();
  const fill = (value: string) =>
    value.replace(ENV_REFERENCE, (_, name: string) => {
      const found = env[name];
      if (found === undefined) missing.add(name);
      return found ?? "";
    });
  const fillAll = (record: Record<string, string> = {}) =>
    Object.fromEntries(Object.entries(record).map(([key, value]) => [key, fill(value)]));
  const timeoutMs = (config.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000;

  let resolved: ResolvedServer;
  if (isHttpConfig(config)) {
    const headers = fillAll(config.headers);
    for (const [name, value] of Object.entries(headers))
      if (/[\r\n\0]/.test(value)) throw new Error(`The value of header ${name} contains a line break.`);
    resolved = { transport: "http", url: config.url, headers, timeoutMs };
  } else {
    resolved = {
      transport: "stdio",
      command: config.command,
      args: (config.args ?? []).map(fill),
      env: fillAll(config.env),
      ...(config.cwd ? { cwd: path.resolve(/*turbopackIgnore: true*/ baseDir, config.cwd) } : {}),
      timeoutMs,
    };
  }
  if (missing.size > 0) {
    const names = [...missing].join(", ");
    throw new Error(`Set the environment variable${missing.size > 1 ? "s" : ""} ${names} used in the MCP config, then restart Tatvam.`);
  }
  return resolved;
}

const quote = (value: string) => (/[\s"']/.test(value) || value === "" ? `"${value.replace(/"/g, '\\"')}"` : value);

/** For display: the command and its (unsubstituted) arguments, or the URL without credentials or query. */
export function describeTarget(config: McpServerConfig): string {
  if (!isHttpConfig(config)) return [config.command, ...(config.args ?? [])].map(quote).join(" ");
  try {
    const url = new URL(config.url);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "(invalid URL)";
  }
}
