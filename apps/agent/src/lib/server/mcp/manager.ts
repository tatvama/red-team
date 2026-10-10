import "server-only";
import { statSync } from "node:fs";
import path from "node:path";
import type { McpServerView } from "@/lib/contract";
import { mcpConfigPath } from "../config";
import { getSetting, setSetting } from "../db";
import type { ToolDefinition } from "../tools/types";
import { McpClient, McpConnectionError, type CallToolResult, type McpTool } from "./client";
import { describeTarget, isHttpConfig, loadMcpConfig, resolveServer, type McpServerConfig } from "./config";
import { HttpTransport } from "./http-transport";
import { errorMessage, type McpTransport } from "./jsonrpc";
import { StdioTransport } from "./stdio-transport";
import { mcpToolName, toToolDefinition, type McpToolHost } from "./tools";

// One manager per server process (kept on globalThis so dev hot reloads reuse live connections).
// It re-reads the config when its mtime changes, connects enabled servers lazily and in parallel,
// and turns their tools into ToolDefinitions.

const DISABLED_SETTING = "mcpDisabled";
/** Longest `getMcpTools()` waits for servers that are still connecting. */
const DEFAULT_WAIT_MS = 8000;
const RETRY_BASE_MS = 5000;
const RETRY_MAX_MS = 5 * 60_000;
/** A connection that lived this long resets the retry backoff when it drops. */
const STABLE_MS = 60_000;

type Phase = "idle" | "connecting" | "connected" | "error" | "disabled";

type ServerState = {
  name: string;
  config: McpServerConfig;
  /** The raw config as JSON; a change restarts the server. */
  key: string;
  /** Directory of the config file, for relative `cwd`. */
  baseDir: string;
  phase: Phase;
  error?: string;
  client?: McpClient;
  connecting?: Promise<void>;
  tools: McpTool[];
  /** Bumped on every connect and stop, so late results from an old attempt are ignored. */
  generation: number;
  failures: number;
  retryAt: number;
  connectedAt: number;
};

type Built = {
  version: number;
  all: ToolDefinition[];
  byServer: Map<string, { definition: ToolDefinition; tool: McpTool }[]>;
};

function createTransport(config: McpServerConfig, baseDir: string): { transport: McpTransport; timeoutMs: number } {
  const resolved = resolveServer(config, process.env, baseDir);
  const transport =
    resolved.transport === "http"
      ? new HttpTransport(resolved.url, resolved.headers)
      : new StdioTransport({ command: resolved.command, args: resolved.args, env: resolved.env, cwd: resolved.cwd });
  return { transport, timeoutMs: resolved.timeoutMs };
}

function delay(ms: number): { promise: Promise<void>; cancel: () => void } {
  let timer: NodeJS.Timeout | undefined;
  const promise = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

class McpManager implements McpToolHost {
  private servers = new Map<string, ServerState>();
  private configError: string | null = null;
  private configFile = "";
  private stamp: string | null = null;
  private version = 0;
  private built?: Built;

  // ── Config ────────────────────────────────────────────────────────────────

  /** Re-reads the config file when its path, mtime or size changed. */
  private reload() {
    const file = mcpConfigPath();
    let stamp: string;
    try {
      const stats = statSync(file);
      stamp = `${file}|${stats.mtimeMs}|${stats.size}`;
    } catch (error) {
      stamp = `${file}|${(error as NodeJS.ErrnoException).code ?? "unreadable"}`;
    }
    if (stamp === this.stamp) return;
    this.stamp = stamp;
    this.configFile = file;
    const config = loadMcpConfig(file);
    this.configError = config.error;
    const baseDir = path.dirname(file);
    const next = new Map<string, ServerState>();
    for (const [name, serverConfig] of Object.entries(config.servers)) {
      const key = JSON.stringify(serverConfig);
      const existing = this.servers.get(name);
      if (existing && existing.key === key && existing.baseDir === baseDir) {
        next.set(name, existing);
        continue;
      }
      if (existing) void this.stop(existing);
      next.set(name, {
        name,
        config: serverConfig,
        key,
        baseDir,
        phase: "idle",
        tools: [],
        generation: 0,
        failures: 0,
        retryAt: 0,
        connectedAt: 0,
      });
    }
    for (const [name, state] of this.servers) if (!next.has(name)) void this.stop(state);
    this.servers = next;
    this.version++;
  }

  private disabledSet(): Set<string> {
    const stored = getSetting<unknown>(DISABLED_SETTING, []);
    return new Set(Array.isArray(stored) ? stored.filter((item): item is string => typeof item === "string") : []);
  }

  private isEnabled(state: ServerState, disabled: Set<string>): boolean {
    return state.config.disabled !== true && !disabled.has(state.name);
  }

  // ── Connections ───────────────────────────────────────────────────────────

  /** Applies enable/disable state and starts connecting servers that need it. */
  private ensureConnecting(): Promise<void>[] {
    this.reload();
    const disabled = this.disabledSet();
    const now = Date.now();
    const waiting: Promise<void>[] = [];
    for (const state of this.servers.values()) {
      if (!this.isEnabled(state, disabled)) {
        if (state.phase !== "disabled") {
          void this.stop(state);
          state.phase = "disabled";
          state.error = undefined;
        }
        continue;
      }
      if (state.phase === "disabled") state.phase = "idle";
      if (state.phase === "idle" || (state.phase === "error" && now >= state.retryAt)) this.connect(state);
      if (state.connecting) waiting.push(state.connecting);
    }
    return waiting;
  }

  private connect(state: ServerState): Promise<void> {
    const generation = ++state.generation;
    state.phase = "connecting";
    state.error = undefined;
    state.tools = [];
    this.version++;
    const attempt = this.open(state, generation).finally(() => {
      if (state.connecting === attempt) state.connecting = undefined;
    });
    state.connecting = attempt;
    return attempt;
  }

  private async open(state: ServerState, generation: number): Promise<void> {
    const current = () => state.generation === generation;
    let client: McpClient | undefined;
    try {
      const { transport, timeoutMs } = createTransport(state.config, state.baseDir);
      const created: McpClient = new McpClient(transport, {
        timeoutMs,
        onToolsChanged: (tools) => {
          if (!current() || state.client !== created) return;
          state.tools = tools;
          this.version++;
        },
        onClose: (error) => {
          // Failures during the handshake are reported by the catch below.
          if (!current() || state.client !== created || state.phase !== "connected") return;
          state.client = undefined;
          state.tools = [];
          this.markError(state, error.message, true);
        },
      });
      client = created;
      state.client = created;
      await created.connect();
      if (!current()) return void created.close();
      state.phase = "connected";
      state.tools = created.tools;
      state.connectedAt = Date.now();
      this.version++;
    } catch (error) {
      if (client) void client.close();
      if (!current()) return;
      if (state.client === client) state.client = undefined;
      this.markError(state, errorMessage(error), false);
    }
  }

  private markError(state: ServerState, message: string, dropped: boolean) {
    const now = Date.now();
    state.failures = dropped && now - state.connectedAt >= STABLE_MS ? 1 : state.failures + 1;
    state.phase = "error";
    state.error = message || "The MCP server failed.";
    state.tools = [];
    state.retryAt = now + Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (state.failures - 1));
    this.version++;
  }

  private async stop(state: ServerState): Promise<void> {
    state.generation++;
    const client = state.client;
    state.client = undefined;
    state.connecting = undefined;
    state.tools = [];
    if (state.phase === "connected" || state.phase === "connecting") state.phase = "idle";
    this.version++;
    if (client) await client.close();
  }

  private async waitFor(promises: Promise<void>[], ms: number) {
    if (promises.length === 0) return;
    const timer = delay(ms);
    try {
      await Promise.race([Promise.allSettled(promises), timer.promise]);
    } finally {
      timer.cancel();
    }
  }

  // ── Tools ─────────────────────────────────────────────────────────────────

  availability(server: string): { ok: true } | { ok: false; reason: string } {
    const state = this.servers.get(server);
    if (state?.phase === "connected" && state.client && !state.client.isClosed) return { ok: true };
    const detail = state?.phase === "error" && state.error ? `: ${state.error.slice(0, 300)}` : ".";
    return { ok: false, reason: `MCP server "${server}" is not connected${detail}` };
  }

  async callTool(server: string, tool: string, args: Record<string, unknown>, signal: AbortSignal): Promise<CallToolResult> {
    const state = this.servers.get(server);
    const client = state?.phase === "connected" ? state.client : undefined;
    if (!client) throw new McpConnectionError(`the server is not connected (${state ? state.phase : "no longer configured"}).`);
    return client.callTool(tool, args, { signal });
  }

  /** Names are assigned across all servers in config order, so collisions resolve the same way each time. */
  private build(): Built {
    if (this.built?.version === this.version) return this.built;
    const used = new Set<string>();
    const all: ToolDefinition[] = [];
    const byServer: Built["byServer"] = new Map();
    for (const state of this.servers.values()) {
      if (state.phase !== "connected") continue;
      const entries = state.tools.map((tool) => {
        const definition = toToolDefinition(state.name, tool, mcpToolName(state.name, tool.name, used), this) as unknown as ToolDefinition;
        all.push(definition);
        return { definition, tool };
      });
      byServer.set(state.name, entries);
    }
    this.built = { version: this.version, all, byServer };
    return this.built;
  }

  async getTools(waitMs = DEFAULT_WAIT_MS): Promise<ToolDefinition[]> {
    await this.waitFor(this.ensureConnecting(), waitMs);
    return this.build().all;
  }

  currentTools(): ToolDefinition[] {
    return this.build().all;
  }

  // ── Views and actions ─────────────────────────────────────────────────────

  private view(state: ServerState, disabled: Set<string>): McpServerView {
    const enabled = this.isEnabled(state, disabled);
    const status: McpServerView["status"] = !enabled ? "disabled" : state.phase === "idle" || state.phase === "disabled" ? "connecting" : state.phase;
    const error =
      status === "error" ? state.error : state.config.disabled === true ? "Disabled in the MCP config file." : undefined;
    return {
      name: state.name,
      transport: isHttpConfig(state.config) ? "http" : "stdio",
      target: describeTarget(state.config),
      enabled,
      status,
      ...(error ? { error } : {}),
      tools: (this.build().byServer.get(state.name) ?? []).map(({ definition, tool }) => ({
        name: definition.name,
        title: definition.title,
        description: tool.description ?? "",
      })),
    };
  }

  /** Lists servers and starts connecting enabled ones in the background (never waits). */
  listServers(): McpServerView[] {
    void this.ensureConnecting();
    const disabled = this.disabledSet();
    const views = [...this.servers.values()].map((state) => this.view(state, disabled));
    if (!this.configError) return views;
    // The contract has no config-level error field, so an unusable file is shown as one failed entry.
    const configEntry: McpServerView = {
      name: path.basename(this.configFile) || "mcp.json",
      transport: "stdio",
      target: this.configFile,
      enabled: false,
      status: "error",
      error: this.configError,
      tools: [],
    };
    return [configEntry, ...views];
  }

  private viewOf(name: string): McpServerView | null {
    const state = this.servers.get(name);
    return state ? this.view(state, this.disabledSet()) : null;
  }

  async setEnabled(name: string, enabled: boolean, waitMs = DEFAULT_WAIT_MS): Promise<McpServerView | null> {
    this.reload();
    const state = this.servers.get(name);
    if (!state) return null;
    const disabled = this.disabledSet();
    if (enabled) disabled.delete(name);
    else disabled.add(name);
    setSetting(DISABLED_SETTING, [...disabled].sort());
    if (enabled) state.failures = 0;
    await this.waitFor(this.ensureConnecting(), waitMs);
    return this.viewOf(name);
  }

  async restart(name: string, waitMs = DEFAULT_WAIT_MS): Promise<McpServerView | null> {
    this.reload();
    const state = this.servers.get(name);
    if (!state) return null;
    if (this.isEnabled(state, this.disabledSet())) {
      await this.stop(state);
      state.phase = "idle";
      state.error = undefined;
      state.failures = 0;
      await this.waitFor(this.ensureConnecting(), waitMs);
    }
    return this.viewOf(name);
  }

  async shutdown(): Promise<void> {
    const states = [...this.servers.values()];
    this.servers = new Map();
    this.stamp = null;
    this.configError = null;
    this.version++;
    await Promise.all(states.map((state) => this.stop(state)));
  }
}

const store = globalThis as unknown as { tatvamMcp?: McpManager };
const manager = () => (store.tatvamMcp ??= new McpManager());

/**
 * Tools from all enabled MCP servers. Connects lazily and in parallel, but never waits longer than
 * about 8 s: slow servers stay "connecting" and their tools appear on a later call.
 */
export function getMcpTools(options: { waitMs?: number } = {}): Promise<ToolDefinition[]> {
  return manager().getTools(options.waitMs);
}

/** Tools of servers that are already connected. Synchronous: never connects or waits. */
export function currentMcpTools(): ToolDefinition[] {
  return manager().currentTools();
}

/** Server status for the settings page. Never shows header or env values. */
export function listMcpServers(): McpServerView[] {
  return manager().listServers();
}

/** Persists the choice and connects or disconnects. Null when the server is not configured. */
export function setMcpServerEnabled(name: string, enabled: boolean, options: { waitMs?: number } = {}): Promise<McpServerView | null> {
  return manager().setEnabled(name, enabled, options.waitMs);
}

/** Reconnects an enabled server. Null when the server is not configured. */
export function restartMcpServer(name: string, options: { waitMs?: number } = {}): Promise<McpServerView | null> {
  return manager().restart(name, options.waitMs);
}

/** Closes every connection (and stops stdio processes). The next call starts fresh. */
export function shutdownMcp(): Promise<void> {
  return store.tatvamMcp ? store.tatvamMcp.shutdown() : Promise.resolve();
}
