import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { ToolCallView } from "@/lib/contract";
import { ToolCard } from "./tool-card";

const baseCall: ToolCallView = {
  id: "call-1",
  name: "read_file",
  title: "Read file",
  arguments: "{}",
  summary: "",
  risk: "read",
  status: "ok",
};

async function renderExpanded(call: ToolCallView) {
  const result = render(<ToolCard call={call} />);
  await userEvent.click(screen.getByRole("button", { expanded: false }));
  return result;
}

describe("ToolCard", () => {
  it("shows title, summary and status, collapsed by default", () => {
    render(<ToolCard call={{ ...baseCall, summary: "Read src/app.ts", status: "running" }} />);
    expect(screen.getByText("Read file")).toBeInTheDocument();
    expect(screen.getByText("Read src/app.ts")).toBeInTheDocument();
    expect(screen.getByText("Running")).toBeInTheDocument();
    expect(screen.getByRole("button", { expanded: false })).toBeInTheDocument();
  });

  it("renders edit_file as a diff", async () => {
    const { container } = await renderExpanded({
      ...baseCall,
      name: "edit_file",
      title: "Edit file",
      risk: "write",
      arguments: JSON.stringify({ path: "src/app.ts", old_string: "const a = 1;\nold line", new_string: "const a = 2;" }),
    });
    const removed = Array.from(container.querySelectorAll(".diff__line--del"), (line) => line.textContent);
    const added = Array.from(container.querySelectorAll(".diff__line--add"), (line) => line.textContent);
    expect(removed).toEqual(["-const a = 1;", "-old line"]);
    expect(added).toEqual(["+const a = 2;"]);
    expect(screen.getByText("src/app.ts")).toBeInTheDocument();
  });

  it("renders run_command as a terminal", async () => {
    await renderExpanded({
      ...baseCall,
      name: "run_command",
      title: "Run command",
      risk: "execute",
      arguments: JSON.stringify({ command: "npm test" }),
      output: "1 passed",
    });
    const terminal = screen.getByLabelText("Command and output");
    expect(terminal).toHaveTextContent("$ npm test");
    expect(terminal).toHaveTextContent("1 passed");
  });

  it("falls back to pretty JSON for unknown tools and tolerates bad arguments", async () => {
    const { unmount } = await renderExpanded({ ...baseCall, name: "custom_tool", arguments: '{"a":1}', output: "fine" });
    expect(screen.getByText(/"a": 1/)).toBeInTheDocument();
    expect(screen.getByText("fine")).toBeInTheDocument();
    unmount();

    await renderExpanded({ ...baseCall, name: "edit_file", arguments: "{not json" });
    expect(screen.getByRole("button", { expanded: true })).toBeInTheDocument();
  });
});
