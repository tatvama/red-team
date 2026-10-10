"use client";

import clsx from "clsx";
import { ChevronRight, RotateCcw } from "lucide-react";
import { useId, useState } from "react";
import type { McpServerView } from "@/lib/contract";
import { errorMessage, type McpAction, updateMcpServer } from "@/lib/client/api";
import { CodeBlock } from "./markdown";

const statusLabels: Record<McpServerView["status"], string> = {
  connected: "Connected",
  connecting: "Connecting…",
  error: "Error",
  disabled: "Disabled",
};

export const MCP_CONFIG_EXAMPLE = [
  "{",
  '  "mcpServers": {',
  '    "files": { "command": "node", "args": ["path/to/server.js"] },',
  '    "remote": {',
  '      "url": "https://example.com/mcp",',
  '      "headers": { "Authorization": "Bearer ${env:MY_TOKEN}" }',
  "    }",
  "  }",
  "}",
].join("\n");

type SwitchProps = { checked: boolean; label: string; disabled?: boolean; onChange: (checked: boolean) => void };

export function Switch({ checked, label, disabled = false, onChange }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className="switch"
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="switch__thumb" aria-hidden="true" />
    </button>
  );
}

type McpServerItemProps = { server: McpServerView; onUpdated: (server: McpServerView) => void };

function McpServerItem({ server, onUpdated }: McpServerItemProps) {
  const [pending, setPending] = useState<McpAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toolsOpen, setToolsOpen] = useState(false);
  const toolsId = useId();

  async function act(action: McpAction) {
    setPending(action);
    setError(null);
    try {
      onUpdated(await updateMcpServer(server.name, action));
    } catch (caught) {
      setError(errorMessage(caught, `Could not ${action} ${server.name}. Please try again.`));
    } finally {
      setPending(null);
    }
  }

  const toolCount = server.tools.length;

  return (
    <li className={clsx("mcp-server", !server.enabled && "mcp-server--disabled")}>
      <div className="mcp-server__head">
        <span className={clsx("connection-dot", `connection-dot--${server.status}`)} aria-hidden="true" />
        <div className="mcp-server__title">
          <h3>{server.name}</h3>
          <span className="mcp-server__status">
            {pending === "restart" ? "Restarting…" : statusLabels[server.status]}
          </span>
        </div>
        <Switch
          checked={server.enabled}
          label={`Enable ${server.name}`}
          disabled={pending !== null}
          onChange={(checked) => void act(checked ? "enable" : "disable")}
        />
        <button
          type="button"
          className="button button--secondary button--small"
          disabled={pending !== null || !server.enabled}
          aria-label={`Restart ${server.name}`}
          onClick={() => void act("restart")}
        >
          <RotateCcw size={13} aria-hidden="true" className={pending === "restart" ? "spin" : undefined} />
          Restart
        </button>
      </div>
      <p className="mcp-server__target">
        <span className="badge">{server.transport === "http" ? "HTTP" : "stdio"}</span>
        <code title={server.target}>{server.target}</code>
      </p>
      {server.error && <p className="mcp-server__error">{server.error}</p>}
      {error && (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}
      {toolCount > 0 ? (
        <>
          <button
            type="button"
            className="mcp-server__tools-toggle"
            aria-expanded={toolsOpen}
            aria-controls={toolsId}
            onClick={() => setToolsOpen(!toolsOpen)}
          >
            <ChevronRight size={13} aria-hidden="true" className="mcp-server__chevron" />
            {toolCount === 1 ? "1 tool" : `${toolCount} tools`}
          </button>
          {toolsOpen && (
            <ul id={toolsId} className="mcp-tools">
              {server.tools.map((tool) => (
                <li key={tool.name} className="mcp-tool">
                  <span className="mcp-tool__name">{tool.title || tool.name}</span>
                  {tool.description && (
                    <span className="mcp-tool__description" title={tool.description}>
                      {tool.description}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        server.status === "connected" && <p className="mcp-server__hint">This server offers no tools.</p>
      )}
    </li>
  );
}

type McpServersProps = {
  servers: McpServerView[];
  configPath: string;
  onUpdated: (server: McpServerView) => void;
};

/** Settings tab: the configured MCP servers, with enable, disable and restart. */
export function McpServers({ servers, configPath, onUpdated }: McpServersProps) {
  return (
    <div className="settings-section">
      <p className="settings-intro">
        MCP servers give Tatvam extra tools. Their tools follow the same approval rules as built-in tools and are
        listed under Tools.
      </p>
      {servers.length === 0 ? (
        <p className="settings-empty">No MCP servers are configured.</p>
      ) : (
        <ul className="mcp-list">
          {servers.map((server) => (
            <McpServerItem key={server.name} server={server} onUpdated={onUpdated} />
          ))}
        </ul>
      )}
      <h3 className="settings-label">Adding servers</h3>
      <p className="settings-hint">
        Servers are configured in <code>{configPath}</code> on the server. They cannot be added from the browser.
        Use <code>{"${env:NAME}"}</code> to read secrets from environment variables. For example:
      </p>
      <CodeBlock code={MCP_CONFIG_EXAMPLE} language="json" />
    </div>
  );
}
