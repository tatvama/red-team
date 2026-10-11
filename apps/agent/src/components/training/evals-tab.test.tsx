import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EvalRunView } from "@/lib/contract";
import { evalRun, evalSuite, evalTaskResult, jsonResponse, readyConnection } from "@/test/fixtures";
import { POLL_INTERVAL_MS } from "./common";
import { EvalsTab } from "./evals-tab";

vi.mock("@/lib/client/navigation", () => ({ navigateTo: vi.fn() }));

const connections = { ollama: readyConnection("ollama", ["qwen3", "qwen3-ft"]), gpu: readyConnection("gpu", ["judge-70b"]) };

const COMPLETED = evalRun();

describe("EvalsTab", () => {
  const fetchMock = vi.fn<typeof fetch>();
  let runs: EvalRunView[];

  function route() {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/evals/suites") return jsonResponse({ suites: [evalSuite()] });
      if (url === "/api/evals/runs" && init?.method === "POST") {
        const request = JSON.parse(String(init.body));
        return jsonResponse(
          evalRun({
            id: "99999999-0000-4000-8000-000000000002",
            target: request.target,
            judge: request.judge,
            status: "queued",
            finishedAt: null,
            results: [],
            summary: { ...COMPLETED.summary, passed: 0, failed: 0, passRate: 0 },
          }),
        );
      }
      if (url === "/api/evals/runs") return jsonResponse({ runs });
      const cancel = /^\/api\/evals\/runs\/([^/]+)\/cancel$/.exec(url);
      if (cancel && init?.method === "POST") {
        const run = runs.find((item) => item.id === cancel[1]);
        return run ? jsonResponse({ ...run, status: "cancelled" }) : jsonResponse({ error: "Not found" }, 404);
      }
      const detail = /^\/api\/evals\/runs\/([^/]+)$/.exec(url);
      if (detail) {
        const run = runs.find((item) => item.id === detail[1]);
        return run ? jsonResponse(run) : jsonResponse({ error: "Not found" }, 404);
      }
      return jsonResponse({ error: "Not found" }, 404);
    });
  }

  beforeEach(() => {
    runs = [COMPLETED];
    route();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    fetchMock.mockReset();
    vi.useRealTimers();
  });

  const callsTo = (url: string, method = "GET") =>
    fetchMock.mock.calls.filter(([target, init]) => target === url && (init?.method ?? "GET") === method);

  it("starts a run with a suite, a target model and a judge", async () => {
    render(<EvalsTab connections={connections} />);
    const suite = await screen.findByRole("combobox", { name: "Suite" });
    expect(suite).toHaveDisplayValue("Core agent skills (2 tasks)");
    expect(screen.getByText("Tool use, small coding tasks and following instructions.")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Start run" }));
    expect(screen.getByText("Choose the model to evaluate.")).toBeInTheDocument();
    expect(callsTo("/api/evals/runs", "POST")).toHaveLength(0);

    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Model to evaluate" }), "ollama:qwen3-ft");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: /Judge model/ }), "gpu:judge-70b");
    await userEvent.click(screen.getByRole("button", { name: "Start run" }));

    await waitFor(() => expect(callsTo("/api/evals/runs", "POST")).toHaveLength(1));
    expect(JSON.parse(String(callsTo("/api/evals/runs", "POST")[0][1]?.body))).toEqual({
      suiteId: "core",
      target: { provider: "ollama", model: "qwen3-ft" },
      judge: { provider: "gpu", model: "judge-70b" },
    });
    expect(await screen.findByText(/qwen3-ft \(Local Ollama\) · judged by judge-70b/)).toBeInTheDocument();
    expect(screen.getByText("Queued")).toBeInTheDocument();
  });

  it("polls every 2 seconds while a run is in progress and stops when it finishes", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const running = evalRun({
      status: "running",
      finishedAt: null,
      results: [evalTaskResult(), evalTaskResult({ taskId: "fix-bug", title: "Fix a failing test", status: "running" })],
    });
    runs = [running];
    render(<EvalsTab connections={connections} />);
    const progress = await screen.findByRole("progressbar", { name: "Core agent skills on qwen3" });
    expect(progress).toHaveAttribute("aria-valuenow", "1");
    expect(progress).toHaveAttribute("aria-valuemax", "2");
    expect(callsTo("/api/evals/runs")).toHaveLength(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    });
    expect(callsTo("/api/evals/runs")).toHaveLength(2);

    runs = [COMPLETED];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    });
    expect(callsTo("/api/evals/runs")).toHaveLength(3);
    expect(await screen.findByText("Completed")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Core agent skills on qwen3" })).toHaveAttribute("aria-valuenow", "2");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
    });
    expect(callsTo("/api/evals/runs")).toHaveLength(3);
  });

  it("stops a running run from the list", async () => {
    runs = [evalRun({ status: "running", finishedAt: null })];
    render(<EvalsTab connections={connections} />);
    await userEvent.click(await screen.findByRole("button", { name: "Stop Core agent skills on qwen3" }));
    await waitFor(() => expect(callsTo(`/api/evals/runs/${COMPLETED.id}/cancel`, "POST")).toHaveLength(1));
    expect(await screen.findByText("Cancelled")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stop Core agent skills on qwen3" })).not.toBeInTheDocument();
  });

  it("shows a run's results with expandable checks and links to the eval conversations", async () => {
    render(<EvalsTab connections={connections} />);
    await userEvent.click(await screen.findByRole("button", { name: "Core agent skills" }));
    expect(await screen.findByRole("heading", { name: "Core agent skills on qwen3" })).toBeInTheDocument();
    expect(callsTo(`/api/evals/runs/${COMPLETED.id}`)).toHaveLength(1);

    const table = screen.getByRole("table", { name: "Results per task" });
    const failedRow = within(table).getByRole("rowheader", { name: /Fix a failing test/ }).closest("tr") as HTMLElement;
    expect(within(failedRow).getByText("Failed")).toBeInTheDocument();
    expect(within(failedRow).getByText("50%")).toBeInTheDocument();
    expect(within(failedRow).getByText("4.2 s")).toBeInTheDocument();

    const toggle = within(failedRow).getByRole("button", { name: "Checks for Fix a failing test: 1 of 2 passed" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("1 test still fails")).toBeInTheDocument();
    expect(screen.getByText("Failed:", { exact: false })).toBeInTheDocument();

    expect(screen.getByRole("link", { name: "Open the conversation for Read a file" })).toHaveAttribute(
      "href",
      "/c/88888888-8888-4888-8888-888888888888",
    );
    expect(screen.queryByRole("button", { name: "Stop run" })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "All runs" }));
    expect(screen.getByRole("heading", { name: "Runs" })).toBeInTheDocument();
  });

  it("compares two runs of a suite and highlights regressions and improvements", async () => {
    const candidate = evalRun({
      id: "99999999-0000-4000-8000-000000000003",
      target: { provider: "ollama", model: "qwen3-ft" },
      startedAt: "2026-10-11T12:00:00.000Z",
      summary: { ...COMPLETED.summary, passRate: 0.75 },
      results: [
        evalTaskResult({ status: "failed", score: 0 }),
        evalTaskResult({ taskId: "fix-bug", title: "Fix a failing test", category: "coding", status: "passed" }),
      ],
    });
    const otherSuite = evalRun({ id: "99999999-0000-4000-8000-000000000004", suiteId: "safety" });
    runs = [COMPLETED, candidate, otherSuite];
    render(<EvalsTab connections={connections} />);
    await userEvent.click(await screen.findByRole("button", { name: "Compare runs" }));

    const baselineSelect = screen.getByRole("combobox", { name: "Baseline run" });
    await userEvent.selectOptions(baselineSelect, COMPLETED.id);
    const candidateSelect = screen.getByRole("combobox", { name: "Candidate run" });
    // Only runs of the same suite can be compared.
    expect(within(candidateSelect).getAllByRole("option").map((option) => option.getAttribute("value"))).toEqual([
      "",
      candidate.id,
    ]);
    await userEvent.selectOptions(candidateSelect, candidate.id);

    const table = screen.getByRole("table", { name: "Results per task, baseline and candidate" });
    const regression = within(table).getByRole("rowheader", { name: "Read a file" }).closest("tr");
    expect(regression).toHaveClass("compare-row--regression");
    expect(regression).toHaveTextContent("Regression");
    const improvement = within(table).getByRole("rowheader", { name: "Fix a failing test" }).closest("tr");
    expect(improvement).toHaveClass("compare-row--improvement");
    expect(improvement).toHaveTextContent("Improvement");

    const change = screen.getByText("Change", { selector: "dt" }).closest(".stat") as HTMLElement;
    expect(change).toHaveTextContent("+25 pts");
    expect(within(change).getByText("+25 pts").closest(".delta")).toHaveClass("delta--up");
  });
});
