import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { PlanItem } from "@/lib/contract";
import { PlanBar, PlanPanel } from "./plan-panel";

const plan: PlanItem[] = [
  { step: "Read the failing test", status: "completed" },
  { step: "Fix the parser", status: "in_progress" },
  { step: "Run the suite", status: "pending" },
];

describe("PlanPanel", () => {
  it("shows a checklist with a progress count", () => {
    render(<PlanPanel plan={plan} onClose={vi.fn()} />);
    expect(screen.getByText("1 of 3")).toBeInTheDocument();
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveClass("plan-item--completed");
    expect(items[1]).toHaveClass("plan-item--in_progress");
    expect(items[1]).toHaveTextContent("Fix the parser (in progress)");
  });

  it("can be hidden", async () => {
    const onClose = vi.fn();
    render(<PlanPanel plan={plan} onClose={onClose} />);
    await userEvent.click(screen.getByRole("button", { name: "Hide plan" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("PlanBar", () => {
  it("shows the current step and expands to the full list", async () => {
    render(<PlanBar plan={plan} />);
    const toggle = screen.getByRole("button", { expanded: false });
    expect(toggle).toHaveTextContent("Fix the parser");
    expect(toggle).toHaveTextContent("1 of 3");
    await userEvent.click(toggle);
    expect(screen.getByRole("button", { expanded: true })).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
  });
});
