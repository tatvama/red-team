import "server-only";
import { routerConfigSchema, type ModelRef, type RouterConfig } from "@/lib/contract";
import { getSetting, setSetting } from "./db";

// The model router: which model answers, which one sub-agents and judges use, a canary share for
// trying a new fine-tune on live traffic, and a fallback when the primary model is down.

const DISABLED: RouterConfig = { enabled: false, main: null, subagent: null, judge: null, fallback: null, canary: null };

export function getRouterConfig(): RouterConfig {
  const parsed = routerConfigSchema.safeParse(getSetting<unknown>("router", DISABLED));
  return parsed.success ? parsed.data : DISABLED;
}

export function saveRouterConfig(config: RouterConfig): RouterConfig {
  setSetting("router", config);
  return config;
}

const same = (a: ModelRef | null, b: ModelRef | null) => !!a && !!b && a.provider === b.provider && a.model === b.model;

/**
 * The model for a turn. Conversations stay on the model they started with (`existing`), so a
 * canary assignment is sticky. `random` is injectable for tests.
 */
export function chooseModel(
  config: RouterConfig,
  input: { requested: ModelRef; existing: ModelRef | null; useRouter: boolean },
  random: () => number = Math.random,
): ModelRef {
  if (!input.useRouter || !config.enabled || !config.main) return input.requested;
  if (input.existing) return input.existing;
  if (config.canary && random() * 100 < config.canary.percent) return config.canary.model;
  return config.main;
}

/** Sub-agents can run on a cheaper or faster model than the main agent. */
export function subagentModel(config: RouterConfig, main: ModelRef): ModelRef {
  return config.enabled && config.subagent ? config.subagent : main;
}

/** The model to retry on when `primary` is unavailable, or null when there is none. */
export function fallbackFor(config: RouterConfig, primary: ModelRef): ModelRef | null {
  if (!config.enabled || !config.fallback || same(config.fallback, primary)) return null;
  return config.fallback;
}
