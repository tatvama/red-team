import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef, type ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { Composer } from "./composer";

function renderComposer(overrides: Partial<ComponentProps<typeof Composer>> = {}) {
  const props: ComponentProps<typeof Composer> = {
    value: "Fix the failing test",
    onChange: vi.fn(),
    onSend: vi.fn(),
    onStop: vi.fn(),
    running: false,
    canSend: true,
    toolbar: null,
    inputRef: createRef<HTMLTextAreaElement>(),
    ...overrides,
  };
  render(<Composer {...props} />);
  return props;
}

describe("Composer", () => {
  it("sends on Enter", async () => {
    const props = renderComposer();
    await userEvent.type(screen.getByRole("textbox", { name: "Message" }), "{Enter}");
    expect(props.onSend).toHaveBeenCalledWith("Fix the failing test");
  });

  it("does not send on Shift+Enter", async () => {
    const props = renderComposer();
    await userEvent.type(screen.getByRole("textbox", { name: "Message" }), "{Shift>}{Enter}{/Shift}");
    expect(props.onSend).not.toHaveBeenCalled();
  });

  it("sends with the send button", async () => {
    const props = renderComposer();
    await userEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(props.onSend).toHaveBeenCalledWith("Fix the failing test");
  });

  it("disables sending when no model is available", async () => {
    const props = renderComposer({ canSend: false, hint: "No model is available yet." });
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    expect(screen.getByText("No model is available yet.")).toBeInTheDocument();
    await userEvent.type(screen.getByRole("textbox", { name: "Message" }), "{Enter}");
    expect(props.onSend).not.toHaveBeenCalled();
  });

  it("disables sending an empty message", () => {
    renderComposer({ value: "   " });
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
  });

  it("shows a Stop button while running", async () => {
    const props = renderComposer({ running: true });
    expect(screen.queryByRole("button", { name: "Send message" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(props.onStop).toHaveBeenCalledOnce();
    await userEvent.type(screen.getByRole("textbox", { name: "Message" }), "{Enter}");
    expect(props.onSend).not.toHaveBeenCalled();
  });
});
