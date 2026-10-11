import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DistillJobView } from "@/lib/contract";
import { distillJob, jsonResponse, readyConnection } from "@/test/fixtures";
import { DistillTab } from "./distill-tab";

vi.mock("@/lib/client/navigation", () => ({ navigateTo: vi.fn() }));

const connections = { ollama: readyConnection("ollama", ["qwen3"]), gpu: readyConnection("gpu", ["big-teacher"]) };

describe("DistillTab", () => {
  const fetchMock = vi.fn<typeof fetch>();
  let jobs: DistillJobView[];

  beforeEach(() => {
    jobs = [distillJob()];
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/training/distill" && init?.method === "POST") {
        const request = JSON.parse(String(init.body));
        return jsonResponse(
          distillJob({
            id: "bbbbbbbb-0000-4000-8000-000000000002",
            teacher: request.teacher,
            status: "queued",
            total: request.source.type === "prompts" ? request.source.prompts.length : request.source.limit,
            completed: 0,
            conversationIds: [],
            finishedAt: null,
          }),
        );
      }
      if (url === "/api/training/distill") return jsonResponse({ jobs });
      const cancel = /^\/api\/training\/distill\/([^/]+)\/cancel$/.exec(url);
      if (cancel && init?.method === "POST") {
        const job = jobs.find((item) => item.id === cancel[1]);
        return job ? jsonResponse({ ...job, status: "cancelled" }) : jsonResponse({ error: "Not found" }, 404);
      }
      return jsonResponse({ error: "Not found" }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => fetchMock.mockReset());

  const posted = () =>
    fetchMock.mock.calls
      .filter(([url, init]) => url === "/api/training/distill" && init?.method === "POST")
      .map(([, init]) => JSON.parse(String(init?.body)) as unknown);

  it("starts a job from prompts, one per line", async () => {
    render(<DistillTab connections={connections} />);
    await userEvent.click(screen.getByRole("button", { name: "Start distillation" }));
    expect(screen.getByText("Choose a teacher model.")).toBeInTheDocument();
    expect(screen.getByText("Enter at least one prompt, one per line.")).toBeInTheDocument();
    expect(posted()).toHaveLength(0);

    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Teacher model" }), "gpu:big-teacher");
    await userEvent.click(screen.getByRole("textbox", { name: "Prompts" }));
    await userEvent.paste("Add a CLI flag\n\n  Explain the parser  \nWrite tests");
    expect(screen.getByText(/One prompt per line · 3 prompts/)).toBeInTheDocument();
    const autoApprove = screen.getByRole("switch", { name: "Approve automatically" });
    expect(autoApprove).toHaveAttribute("aria-checked", "false");
    await userEvent.click(autoApprove);
    await userEvent.click(screen.getByRole("button", { name: "Start distillation" }));

    await waitFor(() => expect(posted()).toHaveLength(1));
    expect(posted()[0]).toEqual({
      teacher: { provider: "gpu", model: "big-teacher" },
      source: { type: "prompts", prompts: ["Add a CLI flag", "Explain the parser", "Write tests"] },
      autoApprove: true,
    });
    expect(await screen.findByText("Queued")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Prompts" })).toHaveValue("");
  });

  it("starts a job from recent conversations with a count", async () => {
    render(<DistillTab connections={connections} />);
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Teacher model" }), "gpu:big-teacher");
    await userEvent.click(screen.getByRole("radio", { name: "Recent conversations" }));
    const count = screen.getByRole("spinbutton", { name: "Number of recent conversations" });
    expect(count).toHaveValue(50);

    await userEvent.clear(count);
    await userEvent.type(count, "600");
    expect(screen.getByText("Enter a whole number from 1 to 500.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Start distillation" }));
    expect(posted()).toHaveLength(0);

    await userEvent.clear(count);
    await userEvent.type(count, "25");
    await userEvent.click(screen.getByRole("button", { name: "Start distillation" }));
    await waitFor(() => expect(posted()).toHaveLength(1));
    expect(posted()[0]).toEqual({
      teacher: { provider: "gpu", model: "big-teacher" },
      source: { type: "history", limit: 25 },
      autoApprove: false,
    });
  });

  it("lists jobs with progress, created conversations and a stop button while running", async () => {
    jobs = [
      distillJob({ id: "bbbbbbbb-0000-4000-8000-000000000003", status: "running", total: 4, completed: 1, failed: 1, finishedAt: null }),
      distillJob(),
    ];
    render(<DistillTab connections={connections} />);
    const progress = await screen.findAllByRole("progressbar", { name: "Distillation with big-teacher" });
    expect(progress[0]).toHaveAttribute("aria-valuenow", "2");
    expect(progress[0]).toHaveAttribute("aria-valuemax", "4");
    expect(screen.getByText(/1 prompt failed/)).toBeInTheDocument();

    const finishedRow = progress[1].closest("li") as HTMLElement;
    expect(within(finishedRow).getByRole("link", { name: "Conversation 1" })).toHaveAttribute(
      "href",
      "/c/cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    );
    expect(within(finishedRow).queryByRole("button", { name: /Stop/ })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Stop distillation with big-teacher" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/training/distill/bbbbbbbb-0000-4000-8000-000000000003/cancel",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    expect(await screen.findByText("Cancelled")).toBeInTheDocument();
  });
});
