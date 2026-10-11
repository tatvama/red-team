import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/client/api";
import { checkpointView } from "@/test/fixtures";
import { RestoreDialog } from "./restore-dialog";

describe("RestoreDialog", () => {
  it("offers both choices for a turn checkpoint and sends the right one", async () => {
    const onConfirm = vi.fn(async () => {});
    const { unmount } = render(
      <RestoreDialog checkpoint={checkpointView()} allowRewind onConfirm={onConfirm} onClose={vi.fn()} />,
    );
    expect(screen.getByRole("dialog", { name: "Rewind to here" })).toBeInTheDocument();
    const both = screen.getByRole("button", { name: "Restore files and conversation" });
    expect(both).toHaveFocus();
    await userEvent.click(both);
    expect(onConfirm).toHaveBeenLastCalledWith(true);
    unmount();

    render(<RestoreDialog checkpoint={checkpointView()} allowRewind onConfirm={onConfirm} onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Restore files only" }));
    expect(onConfirm).toHaveBeenLastCalledWith(false);
  });

  it("offers only a file restore for a tool checkpoint", async () => {
    const onConfirm = vi.fn(async () => {});
    render(
      <RestoreDialog
        checkpoint={checkpointView({ kind: "tool", messageId: null, toolCallId: "call-1" })}
        allowRewind
        onConfirm={onConfirm}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByRole("dialog", { name: "Restore files" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /conversation/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Restore files" }));
    expect(onConfirm).toHaveBeenCalledWith(false);
  });

  it("stays open with the error when the restore fails", async () => {
    const onClose = vi.fn();
    const onConfirm = vi.fn(async () => {
      throw new ApiError("The agent is running.", 409);
    });
    render(<RestoreDialog checkpoint={checkpointView()} allowRewind onConfirm={onConfirm} onClose={onClose} />);
    await userEvent.click(screen.getByRole("button", { name: "Restore files only" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The agent is running.");
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Restore files only" })).toBeEnabled();
  });

  it("closes on Escape and Cancel", async () => {
    const onClose = vi.fn();
    render(<RestoreDialog checkpoint={checkpointView()} allowRewind={false} onConfirm={vi.fn()} onClose={onClose} />);
    await userEvent.keyboard("{Escape}");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
