import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitAction } from "@/lib/contract";
import { checkpointView, gitChanges, jsonResponse, workspaceInfo } from "@/test/fixtures";
import { ChangesPanel } from "./changes-panel";
import { compareUrl } from "./git-actions";

const ID = "22222222-2222-4222-8222-222222222222";

describe("ChangesPanel", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockImplementation(async () => jsonResponse({ message: "Done.", url: "https://github.com/acme/app/pull/7" }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => fetchMock.mockReset());

  function renderPanel(overrides: Partial<ComponentProps<typeof ChangesPanel>> = {}) {
    const props: ComponentProps<typeof ChangesPanel> = {
      conversationId: ID,
      title: "Fix the parser",
      changes: gitChanges(),
      error: null,
      checkpoints: [],
      busy: false,
      onClose: vi.fn(),
      onRefresh: vi.fn(async () => {}),
      onGitDone: vi.fn(),
      onRestore: vi.fn(),
      ...overrides,
    };
    render(<ChangesPanel {...props} />);
    return props;
  }

  /** The git actions sent, in order. */
  const sentActions = () =>
    fetchMock.mock.calls.map(([url, init]) => {
      expect(url).toBe(`/api/conversations/${ID}/git`);
      expect(init?.method).toBe("POST");
      return JSON.parse(String(init?.body)) as GitAction;
    });

  it("summarises the branch, commits ahead and uncommitted changes", () => {
    renderPanel();
    expect(screen.getByRole("heading", { name: "Changes" })).toHaveFocus();
    expect(screen.getByText("tatvam/fix-parser")).toBeInTheDocument();
    expect(screen.getByText("main")).toBeInTheDocument();
    expect(screen.getByText("2 commits ahead · uncommitted changes")).toBeInTheDocument();
    expect(screen.getByText("1 file changed")).toBeInTheDocument();
  });

  it("shows why git review is unavailable", () => {
    renderPanel({
      changes: gitChanges({ available: false, reason: "The workspace is not a git repository.", files: [] }),
    });
    expect(screen.getByText("The workspace is not a git repository.")).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Git actions" })).not.toBeInTheDocument();
  });

  it("commits with a message prefilled from the title", async () => {
    const props = renderPanel();
    await userEvent.click(screen.getByRole("button", { name: "Commit" }));
    const message = screen.getByRole("textbox", { name: "Commit message" });
    expect(message).toHaveValue("Fix the parser");
    expect(message).toHaveFocus();
    await userEvent.clear(message);
    await userEvent.type(message, "Fix escapes in the parser");
    await userEvent.click(within(screen.getByRole("form", { name: "Commit changes" })).getByRole("button", { name: "Commit" }));

    expect(sentActions()).toEqual([{ action: "commit", message: "Fix escapes in the parser" }]);
    expect(await screen.findByText("Done.")).toBeInTheDocument();
    expect(props.onGitDone).toHaveBeenCalledWith("commit");
  });

  it("pushes", async () => {
    renderPanel();
    await userEvent.click(screen.getByRole("button", { name: "Push" }));
    expect(sentActions()).toEqual([{ action: "push" }]);
  });

  it("creates a pull request and links to it in a new tab", async () => {
    renderPanel();
    await userEvent.click(screen.getByRole("button", { name: "Create pull request" }));
    expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue("Fix the parser");
    await userEvent.type(screen.getByRole("textbox", { name: "Description" }), "Handles escaped quotes.");
    await userEvent.click(screen.getByRole("checkbox", { name: "Open as a draft" }));
    const form = screen.getByRole("form", { name: "Create pull request" });
    await userEvent.click(within(form).getByRole("button", { name: "Create pull request" }));

    expect(sentActions()).toEqual([
      { action: "pull_request", title: "Fix the parser", body: "Handles escaped quotes.", draft: true },
    ]);
    const link = await screen.findByRole("link", { name: /Open/ });
    expect(link).toHaveAttribute("href", "https://github.com/acme/app/pull/7");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noreferrer");
  });

  it("offers a compare page when it cannot open pull requests itself", () => {
    renderPanel({ changes: gitChanges({ canOpenPullRequest: false }) });
    expect(screen.queryByRole("button", { name: "Create pull request" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open compare page" })).toHaveAttribute(
      "href",
      "https://github.com/acme/app/compare/main...tatvam/fix-parser",
    );
  });

  it("asks for confirmation before merging", async () => {
    renderPanel();
    await userEvent.click(screen.getByRole("button", { name: "Merge into main" }));
    expect(fetchMock).not.toHaveBeenCalled();
    const confirm = screen.getByRole("group", { name: /Merge tatvam\/fix-parser into main/ });
    await userEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("group", { name: /Merge tatvam/ })).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Merge into main" }));
    await userEvent.click(within(screen.getByRole("group", { name: /Merge tatvam/ })).getByRole("button", { name: "Merge" }));
    expect(sentActions()).toEqual([{ action: "merge" }]);
  });

  it("asks for a danger confirmation before discarding the worktree", async () => {
    renderPanel();
    await userEvent.click(screen.getByRole("button", { name: "Discard worktree" }));
    expect(fetchMock).not.toHaveBeenCalled();
    const confirm = screen.getByRole("group", { name: /Discard this worktree\?/ });
    // Focus starts on Cancel so Enter does not destroy work.
    expect(within(confirm).getByRole("button", { name: "Cancel" })).toHaveFocus();
    await userEvent.click(within(confirm).getByRole("button", { name: "Discard worktree" }));
    expect(sentActions()).toEqual([{ action: "discard" }]);
  });

  it("offers merge and discard only for worktree tasks", () => {
    renderPanel({ changes: gitChanges({ workspace: workspaceInfo({ mode: "shared", branch: "main" }) }) });
    expect(screen.queryByRole("button", { name: /Merge into/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Discard worktree" })).not.toBeInTheDocument();
  });

  it("disables actions while the agent runs", () => {
    renderPanel({ busy: true });
    for (const name of ["Commit", "Push", "Create pull request", "Merge into main", "Discard worktree"]) {
      expect(screen.getByRole("button", { name })).toBeDisabled();
    }
  });

  it("shows the server's error when an action fails", async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ error: "The agent is running." }, 409));
    const props = renderPanel();
    await userEvent.click(screen.getByRole("button", { name: "Push" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The agent is running.");
    expect(props.onGitDone).not.toHaveBeenCalled();
  });

  it("switches between unified and split layouts", async () => {
    renderPanel();
    expect(screen.getByRole("table", { name: /unified view/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("radio", { name: "Split" }));
    expect(screen.getByRole("table", { name: /side by side/ })).toBeInTheDocument();
  });

  it("lists checkpoints newest first on the Timeline tab", async () => {
    const older = checkpointView({ id: "c1", label: "Before: Fix the parser", createdAt: "2026-10-10T10:00:00.000Z" });
    const newer = checkpointView({
      id: "c2",
      kind: "tool",
      label: "Before: Edit parser.ts",
      messageId: null,
      toolCallId: "call-1",
      createdAt: "2026-10-10T11:00:00.000Z",
    });
    const props = renderPanel({ checkpoints: [older, newer] });
    await userEvent.click(screen.getByRole("tab", { name: /Timeline/ }));
    const items = within(screen.getByRole("list", { name: /Checkpoints/ })).getAllByRole("listitem");
    expect(items.map((item) => item.querySelector(".timeline-item__label")?.textContent)).toEqual([
      "Before: Edit parser.ts",
      "Before: Fix the parser",
    ]);
    // Only turn checkpoints can rewind the conversation.
    expect(within(items[0]).queryByRole("button", { name: /Rewind conversation here/ })).not.toBeInTheDocument();
    await userEvent.click(within(items[1]).getByRole("button", { name: /Rewind conversation here/ }));
    expect(props.onRestore).toHaveBeenCalledWith(older, true);
    await userEvent.click(within(items[0]).getByRole("button", { name: /Restore files/ }));
    expect(props.onRestore).toHaveBeenCalledWith(newer, false);
  });

  it("closes on Escape", async () => {
    const props = renderPanel();
    await userEvent.keyboard("{Escape}");
    expect(props.onClose).toHaveBeenCalledOnce();
  });
});

describe("compareUrl", () => {
  it("builds a compare link and keeps slashes in branch names", () => {
    expect(compareUrl("https://github.com/acme/app/", "main", "tatvam/fix #1")).toBe(
      "https://github.com/acme/app/compare/main...tatvam/fix%20%231",
    );
    expect(compareUrl("https://github.com/acme/app", null, "x")).toBe("https://github.com/acme/app");
  });
});
