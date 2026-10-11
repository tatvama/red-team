import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ToolCallView } from "@/lib/contract";
import { ApprovalCard } from "./approval-card";

const call: ToolCallView = {
  id: "call-7",
  name: "run_command",
  title: "Run command",
  arguments: '{"command":"npm test"}',
  summary: "Run npm test",
  risk: "execute",
  status: "awaiting_approval",
};

describe("ApprovalCard", () => {
  it("explains the action and shows its details", () => {
    render(<ApprovalCard call={call} onDecision={vi.fn()} disabled={false} />);
    expect(screen.getByRole("heading", { name: "Run npm test" })).toBeInTheDocument();
    expect(screen.getByText("Runs a command")).toBeInTheDocument();
    expect(screen.getByLabelText("Command and output")).toHaveTextContent("$ npm test");
    expect(screen.getByRole("button", { name: "Approve" })).toHaveFocus();
  });

  it.each([
    ["Approve", "approve"],
    ["Always allow in this chat", "approve_always"],
    ["Deny", "deny"],
  ] as const)("%s sends the %s decision", async (label, decision) => {
    const onDecision = vi.fn();
    render(<ApprovalCard call={call} onDecision={onDecision} disabled={false} />);
    await userEvent.click(screen.getByRole("button", { name: label }));
    expect(onDecision).toHaveBeenCalledWith("call-7", decision);
  });

  it("disables every button while a decision is in flight", () => {
    render(<ApprovalCard call={call} onDecision={vi.fn()} disabled />);
    for (const name of ["Approve", "Always allow in this chat", "Deny"]) {
      expect(screen.getByRole("button", { name })).toBeDisabled();
    }
  });
});
