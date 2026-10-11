import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { navigateTo } from "@/lib/client/navigation";
import { jsonResponse, trainingConversation } from "@/test/fixtures";
import { parseTrainingTab } from "./tabs";
import { TrainingApp } from "./training-app";

vi.mock("@/lib/client/navigation", () => ({ navigateTo: vi.fn() }));

describe("TrainingApp", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    window.history.replaceState(null, "", "/training");
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith("/api/models?provider=ollama")) return jsonResponse({ provider: "ollama", state: "ready", models: ["qwen3"] });
      if (url.startsWith("/api/models?provider=gpu")) return jsonResponse({ provider: "gpu", state: "unconfigured", models: [] });
      if (url.startsWith("/api/training/conversations")) return jsonResponse({ conversations: [trainingConversation()] });
      if (url === "/api/training/exports") return jsonResponse({ exports: [] });
      return jsonResponse({ error: "Not found" }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    fetchMock.mockReset();
    vi.mocked(navigateTo).mockClear();
  });

  it("opens on Review, links back to tasks and keeps the chosen tab in the address", async () => {
    render(<TrainingApp />);
    expect(screen.getByRole("heading", { level: 1, name: "Training" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Tasks/ })).toHaveAttribute("href", "/");
    const review = screen.getByRole("tab", { name: "Review" });
    expect(review).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByRole("link", { name: "Fix the parser" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("tab", { name: "Datasets" }));
    expect(screen.getByRole("tab", { name: "Datasets" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel", { name: "Datasets" })).toBeInTheDocument();
    expect(window.location.search).toBe("?tab=datasets");

    // Arrow keys move between tabs, as in the settings dialog.
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Evaluations" })).toHaveFocus();
    expect(window.location.search).toBe("?tab=evaluations");
    await userEvent.keyboard("{Home}");
    expect(review).toHaveFocus();
    expect(window.location.pathname + window.location.search).toBe("/training");
  });

  it("opens the tab named in the address", () => {
    render(<TrainingApp initialTab={parseTrainingTab("models")} />);
    expect(screen.getByRole("tab", { name: "Models" })).toHaveAttribute("aria-selected", "true");
    expect(parseTrainingTab("nonsense")).toBe("review");
    expect(parseTrainingTab(["distillation", "models"])).toBe("distillation");
  });

  it("sends an expired remote session to the sign-in page", async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ error: "Unauthorized" }, 401));
    render(<TrainingApp />);
    await waitFor(() => expect(navigateTo).toHaveBeenCalledWith("/login"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Your session has expired. Sign in again.");
  });
});
