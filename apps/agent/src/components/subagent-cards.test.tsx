import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { ToolCallView } from "@/lib/contract";
import { subagentView } from "@/test/fixtures";
import { SubagentGrid } from "./subagent-cards";
import { ToolCard } from "./tool-card";

const delegateCall: ToolCallView = {
  id: "call-delegate",
  name: "delegate_tasks",
  title: "Delegate tasks",
  arguments: "{}",
  summary: "2 tasks",
  risk: "read",
  status: "running",
};

describe("SubagentGrid", () => {
  it("shows role, task, status, steps and the live activity", () => {
    render(
      <SubagentGrid
        subagents={[
          subagentView({ id: "s1", role: "researcher", status: "running", steps: 3, activity: "Searching the web" }),
          subagentView({ id: "s2", role: "tester", task: "Run the parser tests", status: "done", steps: 1, activity: "Done" }),
          subagentView({ id: "s3", role: "reviewer", task: "Review the diff", status: "error", report: "Model offline" }),
          subagentView({ id: "s4", role: "general", task: "Tidy up", status: "stopped" }),
        ]}
      />,
    );
    const cards = screen.getAllByRole("article");
    expect(cards).toHaveLength(4);

    expect(within(cards[0]).getByText("Researcher")).toBeInTheDocument();
    expect(within(cards[0]).getByText("Running")).toBeInTheDocument();
    expect(within(cards[0]).getByText("3 steps")).toBeInTheDocument();
    expect(within(cards[0]).getByText("Searching the web")).toBeInTheDocument();

    expect(within(cards[1]).getByText("Tester")).toBeInTheDocument();
    expect(within(cards[1]).getByText("Done", { selector: ".status-chip" })).toBeInTheDocument();
    expect(within(cards[1]).getByText("1 step")).toBeInTheDocument();
    // The activity line is only shown while the sub-agent runs.
    expect(within(cards[1]).queryByText("Done", { selector: ".subagent-card__activity" })).not.toBeInTheDocument();

    expect(within(cards[2]).getByText("Error")).toBeInTheDocument();
    expect(within(cards[3]).getByText("Stopped")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Sub-agents: 4, 1 running" })).toBeInTheDocument();
  });

  it("expands the report as markdown", async () => {
    render(<SubagentGrid subagents={[subagentView({ status: "done", report: "Found **two** issues." })]} />);
    const toggle = screen.getByRole("button", { name: "Show report" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("two")).not.toBeInTheDocument();
    await userEvent.click(toggle);
    expect(screen.getByRole("button", { name: "Hide report" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("two", { selector: "strong" })).toBeInTheDocument();
  });

  it("has no report toggle before there is a report", () => {
    render(<SubagentGrid subagents={[subagentView({ report: "" })]} />);
    expect(screen.queryByRole("button", { name: /report/ })).not.toBeInTheDocument();
  });
});

describe("ToolCard with sub-agents", () => {
  it("renders the sub-agent grid under a delegate_tasks card", () => {
    render(<ToolCard call={delegateCall} subagents={[subagentView(), subagentView({ id: "s2", task: "Second task" })]} />);
    expect(screen.getByText("Delegate tasks")).toBeInTheDocument();
    expect(screen.getAllByRole("article")).toHaveLength(2);
  });

  it("ignores sub-agents for other tools", () => {
    render(<ToolCard call={{ ...delegateCall, name: "read_file" }} subagents={[subagentView()]} />);
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
  });
});
