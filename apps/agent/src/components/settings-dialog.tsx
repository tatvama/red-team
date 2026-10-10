"use client";

import clsx from "clsx";
import { Check, CircleAlert, RotateCcw, Trash2, X } from "lucide-react";
import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import {
  type McpServerView,
  type ModelConnection,
  type Provider,
  providerNames,
  type SettingsView,
  type ToolInfo,
  type ToolPolicy,
  type ToolRisk,
} from "@/lib/contract";
import { deleteMemory, errorMessage, fetchSettings, saveSettings } from "@/lib/client/api";
import { McpServers } from "./mcp-servers";
import { ConnectionDot, connectionStatus, providers } from "./model-picker";
import { Segmented, type SegmentedOption } from "./segmented";
import { ToolIcon } from "./tool-card";
import { useDialog } from "./use-dialog";

const INSTRUCTIONS_LIMIT = 4000;

const tabs = [
  { id: "models", label: "Models" },
  { id: "tools", label: "Tools" },
  { id: "mcp", label: "MCP servers" },
  { id: "instructions", label: "Instructions" },
  { id: "memories", label: "Memories" },
  { id: "workspace", label: "Workspace" },
] as const;
type TabId = (typeof tabs)[number]["id"];

const riskLabels: Record<ToolRisk, string> = {
  read: "Reads",
  write: "Edits",
  execute: "Runs commands",
  network: "Internet",
};

const policyOptions: SegmentedOption<ToolPolicy>[] = [
  { value: "auto", label: "Auto" },
  { value: "ask", label: "Ask" },
  { value: "off", label: "Off" },
];

const providerSetup: Record<Provider, string> = {
  ollama: "OLLAMA_BASE_URL (defaults to http://127.0.0.1:11434/v1) and optional OLLAMA_API_KEY",
  gpu: "GPU_BASE_URL and GPU_API_KEY",
};

const runners: { value: SettingsView["commandRunner"]; label: string; description: string }[] = [
  { value: "docker", label: "Docker", description: "Commands run in an isolated container with only the workspace mounted." },
  { value: "host", label: "Host", description: "Commands run directly on this machine with your user's permissions." },
  { value: "off", label: "Off", description: "The agent can read and edit files but cannot run commands." },
];

type ToolGroup = { key: string; label: string; mcp: boolean; tools: ToolInfo[] };

/** Built-in tools first, then one group per MCP server in the order the server lists them. */
export function groupTools(tools: ToolInfo[]): ToolGroup[] {
  const builtin: ToolInfo[] = [];
  const servers = new Map<string, ToolInfo[]>();
  for (const tool of tools) {
    const server = typeof tool.source === "object" && tool.source !== null ? tool.source.mcpServer : null;
    if (server === null) {
      builtin.push(tool);
    } else {
      const list = servers.get(server);
      if (list) list.push(tool);
      else servers.set(server, [tool]);
    }
  }
  const groups: ToolGroup[] = builtin.length > 0 ? [{ key: "builtin", label: "Built-in", mcp: false, tools: builtin }] : [];
  for (const [server, list] of servers) groups.push({ key: `mcp:${server}`, label: server, mcp: true, tools: list });
  return groups;
}

type LoadState = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; settings: SettingsView };
type SaveState = { status: "idle" } | { status: "saving" } | { status: "saved" } | { status: "error"; message: string };

type SettingsDialogProps = {
  onClose: () => void;
  connections: Record<Provider, ModelConnection | null>;
  onRecheck: () => void;
};

export function SettingsDialog({ onClose, connections, onRecheck }: SettingsDialogProps) {
  const [tab, setTab] = useState<TabId>("models");
  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  const [reloadKey, setReloadKey] = useState(0);
  const [instructions, setInstructions] = useState("");
  const [policies, setPolicies] = useState<Record<string, ToolPolicy>>({});
  const [save, setSave] = useState<SaveState>({ status: "idle" });
  const [memoryError, setMemoryError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const baseId = useId();
  useDialog(dialogRef, onClose, '[role="tab"][aria-selected="true"]');

  useEffect(() => {
    let cancelled = false;
    fetchSettings()
      .then((settings) => {
        if (cancelled) return;
        setLoad({ status: "ready", settings });
        setInstructions(settings.instructions);
        setPolicies(Object.fromEntries(settings.tools.map((tool) => [tool.name, tool.policy])));
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoad({ status: "error", message: errorMessage(error, "Settings could not be loaded.") });
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const settings = load.status === "ready" ? load.settings : null;
  const dirty =
    settings !== null &&
    (instructions !== settings.instructions || settings.tools.some((tool) => policies[tool.name] !== tool.policy));

  function onTabKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const index = tabs.findIndex((item) => item.id === tab);
    const nextIndex =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? (index + 1) % tabs.length
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? (index - 1 + tabs.length) % tabs.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? tabs.length - 1
              : -1;
    if (nextIndex === -1) return;
    event.preventDefault();
    setTab(tabs[nextIndex].id);
    document.getElementById(`${baseId}-tab-${tabs[nextIndex].id}`)?.focus();
  }

  async function onSave() {
    if (!settings) return;
    setSave({ status: "saving" });
    try {
      const updated = await saveSettings({ instructions, toolPolicies: policies });
      setLoad({ status: "ready", settings: updated });
      setInstructions(updated.instructions);
      setPolicies(Object.fromEntries(updated.tools.map((tool) => [tool.name, tool.policy])));
      setSave({ status: "saved" });
    } catch (error) {
      setSave({ status: "error", message: errorMessage(error, "Settings could not be saved.") });
    }
  }

  /** Applies an MCP server change in place, then quietly refreshes the tool list it affects. */
  function onMcpUpdated(server: McpServerView) {
    setLoad((current) =>
      current.status === "ready"
        ? {
            status: "ready",
            settings: {
              ...current.settings,
              mcpServers: current.settings.mcpServers.map((item) => (item.name === server.name ? server : item)),
            },
          }
        : current,
    );
    fetchSettings()
      .then((fresh) => {
        setLoad((current) =>
          current.status === "ready"
            ? { status: "ready", settings: { ...current.settings, tools: fresh.tools, mcpServers: fresh.mcpServers } }
            : current,
        );
        // Keep unsaved policy edits; tools that just appeared start at their saved policy.
        setPolicies((current) => ({ ...Object.fromEntries(fresh.tools.map((tool) => [tool.name, tool.policy])), ...current }));
      })
      .catch(() => {
        // The server list already shows the change; the tool list catches up on the next open.
      });
  }

  async function onDeleteMemory(id: string) {
    setMemoryError(null);
    try {
      await deleteMemory(id);
      setLoad((current) =>
        current.status === "ready"
          ? { status: "ready", settings: { ...current.settings, memories: current.settings.memories.filter((m) => m.id !== id) } }
          : current,
      );
    } catch (error) {
      setMemoryError(errorMessage(error, "The memory could not be deleted."));
    }
  }

  function renderPanel() {
    if (tab === "models") {
      return (
        <div className="settings-section">
          <p className="settings-intro">
            Tatvam talks to models through the server. Addresses and keys stay in <code>.env.local</code> and never
            reach the browser.
          </p>
          {providers.map((provider) => {
            const connection = connections[provider];
            return (
              <div key={provider} className="settings-card">
                <div className="settings-card__head">
                  <ConnectionDot connection={connection} />
                  <h3>{providerNames[provider]}</h3>
                  <span className="settings-card__meta">{connectionStatus(connection)}</span>
                </div>
                {connection?.state === "ready" && (
                  <ul className="model-chips" aria-label={`${providerNames[provider]} models`}>
                    {connection.models.map((model) => (
                      <li key={model} className="model-chip">
                        {model}
                      </li>
                    ))}
                  </ul>
                )}
                <p className="settings-card__hint">
                  Configure with {providerSetup[provider]} in <code>.env.local</code>.
                </p>
              </div>
            );
          })}
          <button type="button" className="button button--secondary" onClick={onRecheck}>
            <RotateCcw size={14} aria-hidden="true" />
            Check connections again
          </button>
        </div>
      );
    }
    if (!settings) {
      return load.status === "error" ? (
        <div className="settings-state" role="alert">
          <CircleAlert size={18} aria-hidden="true" />
          <p>{load.message}</p>
          <button
            type="button"
            className="button button--secondary"
            onClick={() => {
              setLoad({ status: "loading" });
              setReloadKey((key) => key + 1);
            }}
          >
            Try again
          </button>
        </div>
      ) : (
        <p className="settings-state">Loading settings…</p>
      );
    }
    switch (tab) {
      case "tools":
        return (
          <div className="settings-section">
            <p className="settings-intro">
              <strong>Auto</strong> runs without asking, <strong>Ask</strong> shows an approval card, <strong>Off</strong>{" "}
              hides the tool from the agent. The permission mode can still require approval.
            </p>
            {groupTools(settings.tools).map((group) => (
              <section key={group.key} className="tool-group" aria-labelledby={`${baseId}-group-${group.key}`}>
                <h3 id={`${baseId}-group-${group.key}`} className="tool-group__title">
                  <span>{group.label}</span>
                  {group.mcp && <span className="badge">MCP</span>}
                </h3>
                <ul className="tool-settings">
                  {group.tools.map((tool) => (
                    <li key={tool.name} className={clsx("tool-setting", !tool.available && "tool-setting--unavailable")}>
                      <span className="tool-setting__icon">
                        <ToolIcon name={tool.name} risk={tool.risk} size={16} />
                      </span>
                      <div className="tool-setting__text">
                        <div className="tool-setting__title">
                          <span>{tool.title}</span>
                          <span className={`risk-badge risk-badge--${tool.risk}`}>{riskLabels[tool.risk]}</span>
                        </div>
                        <p className="tool-setting__description" title={tool.description}>
                          {tool.description}
                        </p>
                        {!tool.available && (
                          <p className="tool-setting__reason">Unavailable{tool.reason ? `: ${tool.reason}` : ""}</p>
                        )}
                      </div>
                      <Segmented
                        label={`${tool.title} policy`}
                        value={policies[tool.name] ?? tool.policy}
                        options={policyOptions}
                        onChange={(value) => {
                          setPolicies((current) => ({ ...current, [tool.name]: value }));
                          setSave({ status: "idle" });
                        }}
                      />
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        );
      case "mcp":
        return (
          <McpServers
            servers={settings.mcpServers ?? []}
            configPath={settings.mcpConfigPath}
            onUpdated={onMcpUpdated}
          />
        );
      case "instructions":
        return (
          <div className="settings-section">
            <label htmlFor={`${baseId}-instructions`} className="settings-label">
              Custom instructions
            </label>
            <p className="settings-intro">
              Tatvam follows these in every task: preferred languages, code style, conventions, things to avoid.
            </p>
            <textarea
              id={`${baseId}-instructions`}
              className="settings-textarea"
              value={instructions}
              maxLength={INSTRUCTIONS_LIMIT}
              rows={10}
              onChange={(event) => {
                setInstructions(event.target.value);
                setSave({ status: "idle" });
              }}
            />
            <p className="settings-counter" aria-live="polite">
              {instructions.length} / {INSTRUCTIONS_LIMIT}
            </p>
          </div>
        );
      case "memories":
        return (
          <div className="settings-section">
            <p className="settings-intro">Things Tatvam was asked to remember across tasks.</p>
            {memoryError && (
              <p className="settings-error" role="alert">
                {memoryError}
              </p>
            )}
            {settings.memories.length === 0 ? (
              <p className="settings-empty">No memories yet.</p>
            ) : (
              <ul className="memory-list">
                {settings.memories.map((memory) => (
                  <li key={memory.id} className="memory-item">
                    <span className="memory-item__text">{memory.text}</span>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`Delete memory: ${memory.text}`}
                      onClick={() => void onDeleteMemory(memory.id)}
                    >
                      <Trash2 size={15} aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      case "workspace":
        return (
          <div className="settings-section">
            <h3 className="settings-label">Workspace folder</h3>
            <p className="settings-intro">The agent can only read and edit files inside this folder.</p>
            <code className="settings-path">{settings.workspaceDir}</code>
            <p className="settings-hint">
              Change it with <code>WORKSPACE_DIR</code> in <code>.env.local</code>.
            </p>
            <h3 className="settings-label">Command runner</h3>
            <ul className="runner-list">
              {runners.map((runner) => (
                <li
                  key={runner.value}
                  className={clsx("runner", runner.value === settings.commandRunner && "runner--current")}
                >
                  <div className="runner__title">
                    <span>{runner.label}</span>
                    {runner.value === "docker" && <span className="badge badge--accent">Recommended</span>}
                    {runner.value === settings.commandRunner && <span className="badge">Current</span>}
                  </div>
                  <p>{runner.description}</p>
                </li>
              ))}
            </ul>
            <p className="settings-hint">
              Change it with <code>COMMAND_RUNNER</code> in <code>.env.local</code> and restart the server.
            </p>
          </div>
        );
    }
  }

  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <header className="dialog__header">
          <h2 id={titleId}>Settings</h2>
          <button type="button" className="icon-button" aria-label="Close settings" onClick={onClose}>
            <X size={18} aria-hidden="true" />
          </button>
        </header>
        <div className="dialog__body">
          <div className="settings-tabs" role="tablist" aria-label="Settings sections" onKeyDown={onTabKeyDown}>
            {tabs.map((item) => (
              <button
                key={item.id}
                id={`${baseId}-tab-${item.id}`}
                type="button"
                role="tab"
                aria-selected={tab === item.id}
                aria-controls={`${baseId}-panel`}
                tabIndex={tab === item.id ? 0 : -1}
                className="settings-tab"
                onClick={() => setTab(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
          <div
            id={`${baseId}-panel`}
            className="settings-panel"
            role="tabpanel"
            aria-labelledby={`${baseId}-tab-${tab}`}
            tabIndex={0}
          >
            {renderPanel()}
          </div>
        </div>
        <footer className="dialog__footer">
          <span className="dialog__status" aria-live="polite">
            {save.status === "saved" && (
              <>
                <Check size={15} aria-hidden="true" /> Saved
              </>
            )}
            {save.status === "error" && <span className="settings-error">{save.message}</span>}
            {save.status !== "saved" && save.status !== "error" && dirty && "Unsaved changes"}
          </span>
          <button type="button" className="button button--ghost" onClick={onClose}>
            Close
          </button>
          <button
            type="button"
            className="button button--primary"
            disabled={!dirty || save.status === "saving"}
            onClick={() => void onSave()}
          >
            {save.status === "saving" ? "Saving…" : "Save"}
          </button>
        </footer>
      </div>
    </div>
  );
}
