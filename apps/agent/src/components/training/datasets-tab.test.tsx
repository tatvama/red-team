import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { datasetExport, jsonResponse } from "@/test/fixtures";
import { DatasetsTab } from "./datasets-tab";

vi.mock("@/lib/client/navigation", () => ({ navigateTo: vi.fn() }));

const EXISTING = datasetExport();

describe("DatasetsTab", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/training/exports" && init?.method === "POST") {
        const request = JSON.parse(String(init.body));
        return jsonResponse(datasetExport({ id: "77777777-0000-4000-8000-00000000000a", request }));
      }
      if (url === "/api/training/exports") return jsonResponse({ exports: [EXISTING] });
      if (url === `/api/training/exports/${EXISTING.id}` && init?.method === "DELETE") return new Response(null, { status: 204 });
      return jsonResponse({ error: "Not found" }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => fetchMock.mockReset());

  const posted = () =>
    fetchMock.mock.calls
      .filter(([url, init]) => url === "/api/training/exports" && init?.method === "POST")
      .map(([, init]) => JSON.parse(String(init?.body)) as unknown);

  it("sends the default export request and says secrets are always masked", async () => {
    render(<DatasetsTab />);
    expect(screen.getByText(/Secrets such as API keys, tokens and passwords are always masked/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Export dataset" }));
    await waitFor(() => expect(posted()).toHaveLength(1));
    expect(posted()[0]).toEqual({
      statuses: ["approved"],
      kinds: ["chat", "distill"],
      requirePositiveFeedback: false,
      redactPii: true,
      evalFraction: 0.1,
      systemPrompt: "agent",
    });
    expect(await screen.findByText("Export created: 45 examples.")).toBeInTheDocument();
  });

  it("sends every option the form offers", async () => {
    render(<DatasetsTab />);
    const statuses = screen.getByRole("group", { name: "Review status" });
    await userEvent.click(within(statuses).getByRole("checkbox", { name: "Unreviewed" }));
    const kinds = screen.getByRole("group", { name: "Conversations" });
    await userEvent.click(within(kinds).getByRole("checkbox", { name: "Distillation" }));
    await userEvent.click(within(kinds).getByRole("checkbox", { name: "Evaluation" }));
    await userEvent.click(screen.getByRole("checkbox", { name: /Require positive feedback/ }));
    await userEvent.click(screen.getByRole("checkbox", { name: /Mask personal data/ }));
    fireEvent.change(screen.getByRole("slider", { name: /Held out for evaluation/ }), { target: { value: "0.25" } });
    expect(screen.getByRole("slider", { name: /Held out for evaluation/ })).toHaveAccessibleName(/25%/);
    await userEvent.click(screen.getByRole("radio", { name: "Minimal" }));
    expect(screen.getByText(/A one-line assistant prompt/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Export dataset" }));
    await waitFor(() => expect(posted()).toHaveLength(1));
    expect(posted()[0]).toEqual({
      statuses: ["unreviewed", "approved"],
      kinds: ["chat", "eval"],
      requirePositiveFeedback: true,
      redactPii: false,
      evalFraction: 0.25,
      systemPrompt: "minimal",
    });
  });

  it("asks for at least one status and kind before exporting", async () => {
    render(<DatasetsTab />);
    await userEvent.click(screen.getByRole("checkbox", { name: "Approved" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Chat" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Distillation" }));
    await userEvent.click(screen.getByRole("button", { name: "Export dataset" }));
    expect(screen.getByText("Choose at least one review status.")).toBeInTheDocument();
    expect(screen.getByText("Choose at least one kind of conversation.")).toBeInTheDocument();
    expect(posted()).toHaveLength(0);
  });

  it("shows an export's stats, breakdowns and file downloads", async () => {
    render(<DatasetsTab />);
    const card = (await screen.findByRole("heading", { name: /Export from/ })).closest("article") as HTMLElement;
    expect(within(card).getByText("Approved · Chat, Distillation · personal data masked · 10% held out · agent prompt")).toBeInTheDocument();

    const stat = (label: string) => within(card).getByText(label).closest(".stat");
    expect(stat("Conversations")).toHaveTextContent("12");
    expect(stat("Training examples")).toHaveTextContent("40");
    expect(stat("Eval examples")).toHaveTextContent("5");
    expect(stat("Preference pairs")).toHaveTextContent("3");
    expect(stat("Duplicates dropped")).toHaveTextContent("2");

    const redactions = within(card).getByRole("heading", { name: "Redactions by kind" }).parentElement as HTMLElement;
    expect(redactions).toHaveTextContent("Api key3");
    expect(redactions).toHaveTextContent("Email1");
    const skipped = within(card).getByRole("heading", { name: "Skipped by reason" }).parentElement as HTMLElement;
    expect(skipped).toHaveTextContent("No assistant reply2");

    const download = within(card).getByRole("link", { name: "Download sft_train.jsonl" });
    expect(download).toHaveAttribute("href", `/api/training/exports/${EXISTING.id}/files/sft_train.jsonl`);
    expect(download).toHaveAttribute("download", "sft_train.jsonl");
    expect(within(card).getByText("20 KB · 40 records")).toBeInTheDocument();
  });

  it("deletes an export after confirmation", async () => {
    render(<DatasetsTab />);
    await userEvent.click(await screen.findByRole("button", { name: /Delete export from/ }));
    const dialog = screen.getByRole("dialog", { name: "Delete export" });
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete export" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledWith(`/api/training/exports/${EXISTING.id}`, expect.objectContaining({ method: "DELETE" }));
    expect(screen.queryByRole("heading", { name: /Export from/ })).not.toBeInTheDocument();
    expect(screen.getByText("No exports yet.")).toBeInTheDocument();
  });
});
