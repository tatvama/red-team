import { useSyncExternalStore } from "react";
import {
  type Isolation,
  isolationSchema,
  type PermissionMode,
  permissionModeSchema,
  type Provider,
  providerSchema,
} from "@/lib/contract";

export type Preferences = {
  provider: Provider | null;
  model: string | null;
  permissionMode: PermissionMode;
  sidebarCollapsed: boolean;
  /** Isolation for new tasks in a git workspace: the last choice made in the composer. */
  isolation: Isolation;
};

export const defaultPreferences: Preferences = {
  provider: null,
  model: null,
  permissionMode: "ask",
  sidebarCollapsed: false,
  isolation: "shared",
};

const STORAGE_KEY = "tatvam.preferences.v1";
const listeners = new Set<() => void>();

// localStorage can throw (private mode, blocked site data). Preferences then live in memory only.
let storageAvailable = true;
let cachedRaw: string | null = null;
let cached: Preferences = defaultPreferences;

function parsePreferences(raw: string | null): Preferences {
  if (!raw) return defaultPreferences;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return defaultPreferences;
    const record = value as Record<string, unknown>;
    const provider = providerSchema.safeParse(record.provider);
    const mode = permissionModeSchema.safeParse(record.permissionMode);
    const isolation = isolationSchema.safeParse(record.isolation);
    return {
      provider: provider.success ? provider.data : null,
      model: typeof record.model === "string" && record.model ? record.model : null,
      permissionMode: mode.success ? mode.data : defaultPreferences.permissionMode,
      sidebarCollapsed: record.sidebarCollapsed === true,
      isolation: isolation.success ? isolation.data : defaultPreferences.isolation,
    };
  } catch {
    return defaultPreferences;
  }
}

/** Returns a stable object until the stored value changes, as `useSyncExternalStore` requires. */
export function readPreferences(): Preferences {
  if (!storageAvailable) return cached;
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    storageAvailable = false;
    return cached;
  }
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cached = parsePreferences(raw);
  }
  return cached;
}

export function writePreferences(update: Partial<Preferences>): void {
  const next = { ...readPreferences(), ...update };
  const raw = JSON.stringify(next);
  try {
    window.localStorage.setItem(STORAGE_KEY, raw);
    cachedRaw = raw;
  } catch {
    storageAvailable = false;
  }
  cached = next;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** Server render and hydration use the defaults; stored values apply right after. */
export function usePreferences(): Preferences {
  return useSyncExternalStore(subscribe, readPreferences, () => defaultPreferences);
}
