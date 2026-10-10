import "server-only";
import type { SettingsUpdate, SettingsView } from "@/lib/contract";
import { knownTools } from "./agent";
import { commandConfig, defaultWorkspaceDir, mcpConfigPath } from "./config";
import * as db from "./db";
import { listMcpServers } from "./mcp/manager";
import type { ToolDefinition } from "./tools/types";

export function settingsView(tools: ToolDefinition[] = knownTools()): SettingsView {
  const settings = db.getSettings();
  return {
    instructions: settings.instructions,
    tools: tools.map((tool) => {
      const availability = tool.available();
      return {
        name: tool.name,
        title: tool.title,
        description: tool.description,
        risk: tool.risk,
        defaultPolicy: tool.defaultPolicy,
        policy: settings.toolPolicies[tool.name] ?? tool.defaultPolicy,
        available: availability.ok,
        ...(availability.ok ? {} : { reason: availability.reason }),
        source: tool.source ?? "builtin",
      };
    }),
    memories: db.listMemories(),
    workspaceDir: defaultWorkspaceDir(),
    commandRunner: commandConfig().runner,
    mcpServers: listMcpServers(),
    mcpConfigPath: mcpConfigPath(),
  };
}

/**
 * Stores only overrides that differ from each tool's default. Unknown names are dropped, except
 * MCP tools whose server is offline right now: their saved policy is kept for when it reconnects.
 */
export function updateSettings(update: SettingsUpdate, tools: ToolDefinition[] = knownTools()): SettingsView {
  const known = new Map(tools.map((tool) => [tool.name, tool]));
  const previous = db.getSettings().toolPolicies;
  const toolPolicies: Record<string, (typeof previous)[string]> = {};
  for (const [name, policy] of Object.entries(previous))
    if (name.startsWith("mcp_") && !known.has(name)) toolPolicies[name] = policy;
  for (const [name, policy] of Object.entries(update.toolPolicies)) {
    const tool = known.get(name);
    if (tool && policy !== tool.defaultPolicy) toolPolicies[name] = policy;
    else if (tool) delete toolPolicies[name];
  }
  db.saveSettings({ instructions: update.instructions, toolPolicies });
  return settingsView(tools);
}
