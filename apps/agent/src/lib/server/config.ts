import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";

/** The workspace of the conversation being served; worktree tasks each get their own folder. */
const workspaceScope = new AsyncLocalStorage<string>();

/** Runs `work` with `workspaceDir()` pointing at `dir` for everything it calls, including tools. */
export function withWorkspace<T>(dir: string | null, work: () => T): T {
  return dir ? workspaceScope.run(dir, work) : work();
}

// Every setting is read at call time so a restart is the only step after editing `.env.local`.
function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const value = Number.parseInt(env(name) ?? "", 10);
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

// Runtime-chosen folders: tell the bundler not to trace them into the server build.
export function dataDir(): string {
  return path.resolve(/*turbopackIgnore: true*/ env("DATA_DIR") ?? "data");
}

/** The configured default workspace, ignoring any per-conversation scope. */
export function defaultWorkspaceDir(): string {
  return path.resolve(/*turbopackIgnore: true*/ env("WORKSPACE_DIR") ?? path.join(dataDir(), "workspace"));
}

export function workspaceDir(): string {
  return workspaceScope.getStore() ?? defaultWorkspaceDir();
}

export function subagentConfig() {
  return {
    maxParallel: intEnv("SUBAGENT_MAX_PARALLEL", 3, 1, 16),
    maxSteps: intEnv("SUBAGENT_MAX_STEPS", 15, 1, 100),
  };
}

export function githubToken(): string | undefined {
  return env("GITHUB_TOKEN");
}

/** Where MCP servers are configured. Servers can only be added by editing this file. */
export function mcpConfigPath(): string {
  return path.resolve(/*turbopackIgnore: true*/ env("MCP_CONFIG") ?? path.join(dataDir(), "mcp.json"));
}

export function agentConfig() {
  const temperature = Number.parseFloat(env("TEMPERATURE") ?? "");
  return {
    /** Model calls per user turn. Coding tasks need many read, edit and test steps. */
    maxSteps: intEnv("AGENT_MAX_STEPS", 40, 1, 200),
    maxOutputTokens: intEnv("MAX_OUTPUT_TOKENS", 8192, 256, 65536),
    /** Approximate prompt budget; older tool output is elided first when a conversation outgrows it. */
    contextTokens: intEnv("CONTEXT_TOKENS", 32_000, 4_000, 2_000_000),
    temperature: Number.isFinite(temperature) ? temperature : undefined,
  };
}

export type ModelEndpoint = { base: URL; headers: Record<string, string> };
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** The browser selects a named connection, never an upstream URL or credential. */
export function modelEndpoint(provider: "ollama" | "gpu"): ModelEndpoint | null {
  try {
    const value = provider === "ollama" ? (env("OLLAMA_BASE_URL") ?? "http://127.0.0.1:11434/v1") : env("GPU_BASE_URL");
    if (!value) return null;
    const base = new URL(value);
    // Plain HTTP leaks prompts and keys on the wire; allow it only on loopback (for example an SSH
    // tunnel) unless the operator opts in for a private network such as WireGuard or Tailscale.
    const httpAllowed = LOOPBACK.has(base.hostname) || env("ALLOW_HTTP_MODEL_URLS") === "true";
    if (base.username || base.password || base.search || base.hash) return null;
    if (base.protocol !== "https:" && !(base.protocol === "http:" && httpAllowed)) return null;
    base.pathname = base.pathname.replace(/\/+$/, "") + "/";
    const key = provider === "gpu" ? env("GPU_API_KEY") : env("OLLAMA_API_KEY");
    return { base, headers: key ? { Authorization: `Bearer ${key}` } : {} };
  } catch {
    return null;
  }
}

export type SearchProvider = "searxng" | "brave" | "tavily";
export type SearchConfig =
  | { provider: "searxng"; url: string }
  | { provider: "brave"; apiKey: string }
  | { provider: "tavily"; apiKey: string };

/** The explicit SEARCH_PROVIDER wins; otherwise the first provider with credentials is used. */
export function searchConfig(): SearchConfig | null {
  const wanted = env("SEARCH_PROVIDER")?.toLowerCase();
  const searxng = env("SEARXNG_URL");
  const brave = env("BRAVE_API_KEY");
  const tavily = env("TAVILY_API_KEY");
  const options: Record<SearchProvider, SearchConfig | null> = {
    searxng: searxng ? { provider: "searxng", url: searxng } : null,
    brave: brave ? { provider: "brave", apiKey: brave } : null,
    tavily: tavily ? { provider: "tavily", apiKey: tavily } : null,
  };
  if (wanted) return wanted in options ? options[wanted as SearchProvider] : null;
  return options.searxng ?? options.brave ?? options.tavily;
}

export type CommandRunner = "off" | "docker" | "host";

/** Shell commands stay off until the operator picks a runner. Docker is the recommended one. */
export function commandConfig() {
  const runner = env("COMMAND_RUNNER")?.toLowerCase();
  return {
    runner: (runner === "docker" || runner === "host" ? runner : "off") as CommandRunner,
    dockerPath: env("DOCKER_PATH") ?? "docker",
    image: env("SANDBOX_IMAGE") ?? "node:24-bookworm",
    /** Sandboxed commands have no network unless this is "true" (needed for npm install and similar). */
    network: env("SANDBOX_NETWORK") === "true",
    /** Optional `uid:gid` for the container process. */
    user: env("SANDBOX_USER"),
    memoryMb: intEnv("SANDBOX_MEMORY_MB", 2048, 128, 65536),
    cpus: intEnv("SANDBOX_CPUS", 2, 1, 64),
    timeoutSeconds: intEnv("COMMAND_TIMEOUT_SECONDS", 120, 5, 3600),
  };
}

export function webFetchConfig() {
  return {
    // Off by default: reaching LAN or loopback services from model output is an SSRF risk.
    allowPrivateNetworks: env("WEB_FETCH_ALLOW_PRIVATE") === "true",
  };
}
