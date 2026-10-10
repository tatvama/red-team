import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ThinkingBlock } from "./thinking-block";

describe("ThinkingBlock", () => {
  it("is expanded while thinking and collapses once the answer starts", () => {
    const { rerender } = render(<ThinkingBlock reasoning="Checking the parser" active />);
    expect(screen.getByRole("button", { name: /Thinking/ })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Checking the parser")).toBeVisible();

    rerender(<ThinkingBlock reasoning="Checking the parser" active={false} />);
    const toggle = screen.getByRole("button", { name: /Thought for a moment/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("Checking the parser")).not.toBeVisible();
  });

  it("expands on click after completion", async () => {
    render(<ThinkingBlock reasoning="Checking the parser" active={false} />);
    await userEvent.click(screen.getByRole("button", { name: /Thought for a moment/ }));
    expect(screen.getByRole("button", { name: /Thought for a moment/ })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Checking the parser")).toBeVisible();
  });
});
