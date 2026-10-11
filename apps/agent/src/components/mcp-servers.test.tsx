import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServerView, SettingsView, ToolInfo } from "@/lib/contract";
import { jsonResponse } from "@/test/fixtures";
import { McpServers } from "./mcp-servers";
import { SettingsDialog } from "./settings-dialog";

const files: McpServerView = {
  name: "files",
  transport: "stdio",
  target: "node path/to/server.js",
  enabled: true,
  status: "connected",
  tools: [
    { name: "list", title: "List files", description: "Lists files in a folder." },
    { name: "read", title: "Read file", description: "Reads one file." },
  ],
};

const remote: McpServerView = {
  name: "remote",
  transport: "http",
  target: "https://example.com/mcp",
  enabled: true,
  status: "error",
  error: "Connection refused",
  tools: [],
};

describe("McpServers", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => vi.stubGlobal("fetch", fetchMock));
  afterEach(() => fetchMock.mockReset());

  function renderServers(servers: McpServerView[] = [files, remote]) {
    const onUpdated = vi.fn();
    render(<McpServers servers={servers} configPath="/data/mcp.json" onUpdated={onUpdated} />);
    return onUpdated;
  }

  it("shows status, transport, target, errors and a collapsible tool list", async () => {
    renderServers();
    const [first, second] = screen.getAllByRole("listitem").filter((item) => item.classList.contains("mcp-server"));
    expect(within(first).getByRole("heading", { name: "files" })).toBeInTheDocument();
    expect(within(first).getByText("Connected")).toBeInTheDocument();
    expect(within(first).getByText("stdio")).toBeInTheDocument();
    expect(within(first).getByText("node path/to/server.js")).toBeInTheDocument();
    expect(within(second).getByText("HTTP")).toBeInTheDocument();
    expect(within(second).getByText("Connection refused")).toBeInTheDocument();

    const toggle = within(first).getByRole("button", { name: "2 tools" });
    expect(within(first).queryByText("List files")).not.toBeInTheDocument();
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(within(first).getByText("List files")).toBeInTheDocument();
  });

  it("disables a server through the endpoint and reports the new state", async () => {
    const disabled: McpServerView = { ...files, enabled: false, status: "disabled" };
    fetchMock.mockResolvedValue(jsonResponse(disabled));
    const onUpdated = renderServers();
    const toggle = screen.getByRole("switch", { name: "Enable files" });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    await userEvent.click(toggle);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/mcp/files");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ action: "disable" });
    expect(onUpdated).toHaveBeenCalledWith(disabled);
  });

  it("enables a disabled server", async () => {
    fetchMock.mockResolvedValue(jsonResponse(files));
    renderServers([{ ...files, enabled: false, status: "disabled" }]);
    expect(screen.getByRole("button", { name: "Restart files" })).toBeDisabled();
    await userEvent.click(screen.getByRole("switch", { name: "Enable files" }));
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ action: "enable" });
  });

  it("restarts a server", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ...remote, status: "connected", error: undefined }));
    const onUpdated = renderServers();
    await userEvent.click(screen.getByRole("button", { name: "Restart remote" }));
    expect(fetchMock.mock.calls[0][0]).toBe("/api/mcp/remote");
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ action: "restart" });
    expect(onUpdated).toHaveBeenCalledWith(expect.objectContaining({ name: "remote", status: "connected" }));
  });

  it("shows an error when the action fails", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "Server failed to start." }, 502));
    const onUpdated = renderServers();
    await userEvent.click(screen.getByRole("button", { name: "Restart files" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Server failed to start.");
    expect(onUpdated).not.toHaveBeenCalled();
  });

  it("explains where servers are configured, with a copyable example", () => {
    renderServers([]);
    expect(screen.getByText("No MCP servers are configured.")).toBeInTheDocument();
    expect(screen.getByText("/data/mcp.json")).toBeInTheDocument();
    expect(screen.getByText(/cannot be added from the browser/)).toBeInTheDocument();
    expect(screen.getByText(/"mcpServers"/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy code" })).toBeInTheDocument();
  });
});

describe("SettingsDialog", () => {
  const tool = (name: string, title: string, source: ToolInfo["source"]): ToolInfo => ({
    name,
    title,
    description: `${title} description`,
    risk: "read",
    defaultPolicy: "auto",
    policy: "auto",
    available: true,
    source,
  });

  const settings: SettingsView = {
    instructions: "",
    tools: [
      tool("mcp_files_list", "List files", { mcpServer: "files" }),
      tool("read_file", "Read file", "builtin"),
      tool("mcp_remote_fetch", "Fetch", { mcpServer: "remote" }),
      tool("web_search", "Web search", "builtin"),
    ],
    memories: [],
    workspaceDir: "/workspace",
    commandRunner: "docker",
    mcpServers: [files],
    mcpConfigPath: "/data/mcp.json",
  };

  it("groups tools by source with built-in first, and has an MCP servers tab", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse(settings));
    vi.stubGlobal("fetch", fetchMock);
    render(<SettingsDialog onClose={vi.fn()} connections={{ ollama: null, gpu: null }} onRecheck={vi.fn()} />);

    await userEvent.click(screen.getByRole("tab", { name: "Tools" }));
    const groups = await screen.findAllByRole("region");
    expect(groups.map((group) => within(group).getByRole("heading").textContent)).toEqual([
      "Built-in",
      "filesMCP",
      "remoteMCP",
    ]);
    expect(within(groups[0]).getAllByRole("radiogroup").map((group) => group.getAttribute("aria-label"))).toEqual([
      "Read file policy",
      "Web search policy",
    ]);

    await userEvent.click(screen.getByRole("tab", { name: "MCP servers" }));
    expect(screen.getByRole("switch", { name: "Enable files" })).toBeInTheDocument();
  });
});
