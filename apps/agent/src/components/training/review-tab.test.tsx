import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrainingConversationView } from "@/lib/contract";
import { jsonResponse, trainingConversation } from "@/test/fixtures";
import { ReviewTab } from "./review-tab";

vi.mock("@/lib/client/navigation", () => ({ navigateTo: vi.fn() }));

const CHAT = trainingConversation();
const EVAL = trainingConversation({
  id: "77777777-0000-4000-8000-000000000001",
  title: "Read a file",
  kind: "eval",
  upCount: 0,
  correctionCount: 2,
  toolCallCount: 1,
});

describe("ReviewTab", () => {
  const fetchMock = vi.fn<typeof fetch>();
  let queue: TrainingConversationView[];
  let failStatus = false;

  beforeEach(() => {
    queue = [CHAT, EVAL];
    failStatus = false;
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.startsWith("/api/training/conversations")) return jsonResponse({ conversations: queue });
      if (url.endsWith("/training") && init?.method === "PUT") {
        return failStatus
          ? jsonResponse({ error: "The database is busy." }, 503)
          : jsonResponse(JSON.parse(String(init.body)));
      }
      return jsonResponse({ error: "Not found" }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => fetchMock.mockReset());

  const listUrls = () =>
    fetchMock.mock.calls.map(([url]) => String(url)).filter((url) => url.startsWith("/api/training/conversations"));

  it("loads the unreviewed queue with counts and links each conversation", async () => {
    render(<ReviewTab />);
    const link = await screen.findByRole("link", { name: "Fix the parser" });
    expect(link).toHaveAttribute("href", `/c/${CHAT.id}`);
    expect(listUrls()).toEqual(["/api/training/conversations?status=unreviewed"]);
    expect(screen.getByText("2 conversations")).toBeInTheDocument();

    const row = link.closest("li") as HTMLElement;
    const counts = within(row).getByRole("list", { name: "Feedback and activity" });
    expect(counts).toHaveTextContent("1 thumbs up");
    expect(counts).toHaveTextContent("0 thumbs down");
    expect(counts).toHaveTextContent("0 corrections");
    expect(counts).toHaveTextContent("3 tool calls");

    const evalRow = screen.getByRole("link", { name: "Read a file" }).closest("li") as HTMLElement;
    expect(within(evalRow).getByText("Evaluation")).toBeInTheDocument();
    expect(within(evalRow).getByText("2 corrections")).toBeInTheDocument();
  });

  it("filters by status and kind", async () => {
    render(<ReviewTab />);
    await screen.findByRole("link", { name: "Fix the parser" });

    await userEvent.click(within(screen.getByRole("radiogroup", { name: "Training status" })).getByRole("radio", { name: "All" }));
    await waitFor(() => expect(listUrls().at(-1)).toBe("/api/training/conversations"));

    queue = [EVAL];
    await userEvent.click(
      within(screen.getByRole("radiogroup", { name: "Conversation kind" })).getByRole("radio", { name: "Evaluation" }),
    );
    await waitFor(() => expect(listUrls().at(-1)).toBe("/api/training/conversations?kind=eval"));
    await waitFor(() => expect(screen.queryByRole("link", { name: "Fix the parser" })).not.toBeInTheDocument());

    await userEvent.click(within(screen.getByRole("radiogroup", { name: "Training status" })).getByRole("radio", { name: "Approved" }));
    await waitFor(() => expect(listUrls().at(-1)).toBe("/api/training/conversations?status=approved&kind=eval"));
  });

  it("approves a conversation and toggles the approval off again", async () => {
    render(<ReviewTab />);
    const approve = await screen.findByRole("button", { name: "Approve Fix the parser" });
    expect(approve).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(approve);

    expect(approve).toHaveAttribute("aria-pressed", "true");
    const row = approve.closest("li") as HTMLElement;
    expect(within(row).getByText("Approved")).toBeInTheDocument();
    const puts = () =>
      fetchMock.mock.calls
        .filter(([, init]) => init?.method === "PUT")
        .map(([url, init]) => [String(url), JSON.parse(String(init?.body))]);
    await waitFor(() => expect(puts()).toEqual([[`/api/conversations/${CHAT.id}/training`, { trainingStatus: "approved" }]]));

    await userEvent.click(approve);
    await waitFor(() => expect(puts()[1]).toEqual([`/api/conversations/${CHAT.id}/training`, { trainingStatus: "unreviewed" }]));
    expect(approve).toHaveAttribute("aria-pressed", "false");
  });

  it("reverts an exclusion that fails and shows the error on the row", async () => {
    failStatus = true;
    render(<ReviewTab />);
    const exclude = await screen.findByRole("button", { name: "Exclude Read a file" });
    await userEvent.click(exclude);

    const row = exclude.closest("li") as HTMLElement;
    expect(await within(row).findByRole("alert")).toHaveTextContent("The database is busy.");
    expect(exclude).toHaveAttribute("aria-pressed", "false");
    expect(within(row).getByText("Unreviewed")).toBeInTheDocument();
  });

  it("offers a retry when the queue cannot be loaded", async () => {
    fetchMock.mockImplementationOnce(async () => jsonResponse({ error: "The review queue is unavailable." }, 500));
    render(<ReviewTab />);
    expect(await screen.findByRole("alert")).toHaveTextContent("The review queue is unavailable.");
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("link", { name: "Fix the parser" })).toBeInTheDocument();
  });
});
