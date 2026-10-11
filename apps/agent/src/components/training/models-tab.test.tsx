import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RegisteredModel, RouterConfig } from "@/lib/contract";
import { jsonResponse, NOW, readyConnection, registeredModel, routerConfig } from "@/test/fixtures";
import { ModelsTab } from "./models-tab";

vi.mock("@/lib/client/navigation", () => ({ navigateTo: vi.fn() }));

const connections = { ollama: readyConnection("ollama", ["qwen3", "qwen3-ft"]), gpu: readyConnection("gpu", ["big-70b"]) };
const BASE = registeredModel();

type Overrides = { register?: (body: unknown) => Response; saveRouter?: (body: unknown) => Response; router?: RouterConfig };

describe("ModelsTab", () => {
  const fetchMock = vi.fn<typeof fetch>();
  let models: RegisteredModel[];

  function route({ register, saveRouter, router = routerConfig() }: Overrides = {}) {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const body: unknown = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (url === "/api/models/registry" && init?.method === "POST") {
        if (register) return register(body);
        const request = body as Omit<RegisteredModel, "id" | "createdAt" | "latestEval">;
        return jsonResponse({ ...request, id: "ffffffff-0000-4000-8000-000000000002", createdAt: NOW, latestEval: null });
      }
      if (url === "/api/models/registry") return jsonResponse({ models });
      const one = /^\/api\/models\/registry\/([^/]+)$/.exec(url);
      if (one && init?.method === "PATCH") {
        const model = models.find((item) => item.id === one[1]);
        return model ? jsonResponse({ ...model, ...(body as object) }) : jsonResponse({ error: "Not found" }, 404);
      }
      if (url === "/api/training/exports") return jsonResponse({ exports: [] });
      if (url === "/api/router" && init?.method === "PUT") return saveRouter ? saveRouter(body) : jsonResponse(body);
      if (url === "/api/router") return jsonResponse(router);
      return jsonResponse({ error: "Not found" }, 404);
    });
  }

  beforeEach(() => {
    models = [BASE];
    route();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => fetchMock.mockReset());

  const bodies = (url: string, method: string) =>
    fetchMock.mock.calls
      .filter(([target, init]) => target === url && init?.method === method)
      .map(([, init]) => JSON.parse(String(init?.body)) as unknown);

  it("lists registered models with their status and latest evaluation", async () => {
    render(<ModelsTab connections={connections} />);
    const table = await screen.findByRole("table", { name: "Registered models" });
    const row = within(table).getByRole("rowheader", { name: /Qwen3 base/ }).closest("tr") as HTMLElement;
    expect(row).toHaveTextContent("Local Ollama / qwen3");
    expect(within(row).getByText("Base")).toBeInTheDocument();
    expect(within(row).getByText("Candidate")).toBeInTheDocument();
    expect(within(row).getByText("50%")).toBeInTheDocument();
  });

  it("registers a model from the connection lists", async () => {
    render(<ModelsTab connections={connections} />);
    await screen.findByRole("table", { name: "Registered models" });
    await userEvent.click(screen.getByRole("button", { name: "Register model" }));
    expect(screen.getByText("Choose the model to register.")).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Model" }), "ollama:qwen3-ft");
    await userEvent.type(screen.getByRole("textbox", { name: /Label/ }), "Qwen3 fine-tune 1");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Kind" }), "finetune");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: /Trained from/ }), BASE.id);
    await userEvent.type(screen.getByRole("textbox", { name: /Notes/ }), "First LoRA run");
    await userEvent.click(screen.getByRole("button", { name: "Register model" }));

    await waitFor(() => expect(bodies("/api/models/registry", "POST")).toHaveLength(1));
    expect(bodies("/api/models/registry", "POST")[0]).toEqual({
      provider: "ollama",
      modelId: "qwen3-ft",
      label: "Qwen3 fine-tune 1",
      kind: "finetune",
      parentId: BASE.id,
      datasetExportId: null,
      status: "candidate",
      notes: "First LoRA run",
    });
    expect(await screen.findByRole("rowheader", { name: /Qwen3 fine-tune 1/ })).toBeInTheDocument();
  });

  it("says when a model is already registered and keeps the form", async () => {
    route({ register: () => jsonResponse({ error: "Already registered" }, 409) });
    render(<ModelsTab connections={connections} />);
    await screen.findByRole("table", { name: "Registered models" });
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Model" }), "ollama:qwen3");
    await userEvent.type(screen.getByRole("textbox", { name: /Label/ }), "Duplicate");
    await userEvent.click(screen.getByRole("button", { name: "Register model" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "qwen3 on Local Ollama is already registered. Change it in the registry instead.",
    );
    expect(screen.getByRole("textbox", { name: /Label/ })).toHaveValue("Duplicate");
    expect(screen.getByRole("combobox", { name: "Model" })).toHaveValue("ollama:qwen3");
  });

  it("promotes a model to active with notes", async () => {
    render(<ModelsTab connections={connections} />);
    await userEvent.click(await screen.findByRole("button", { name: "Promote Qwen3 base to active" }));
    const dialog = screen.getByRole("dialog", { name: "Promote to active: Qwen3 base" });
    const notes = within(dialog).getByRole("textbox", { name: "Notes" });
    expect(notes).toHaveFocus();
    await userEvent.type(notes, "Best pass rate on core");
    await userEvent.click(within(dialog).getByRole("button", { name: "Promote" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(bodies(`/api/models/registry/${BASE.id}`, "PATCH")).toEqual([{ status: "active", notes: "Best pass rate on core" }]);
    const row = screen.getByRole("rowheader", { name: /Qwen3 base/ }).closest("tr") as HTMLElement;
    expect(within(row).getByText("Active")).toBeInTheDocument();
    expect(within(row).getByText("Best pass rate on core")).toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: /Promote/ })).not.toBeInTheDocument();
    expect(within(row).getByRole("button", { name: "Retire Qwen3 base" })).toBeInTheDocument();
  });

  it("saves the router with its models and canary", async () => {
    render(<ModelsTab connections={connections} />);
    const save = await screen.findByRole("button", { name: "Save router" });
    expect(save).toBeDisabled();

    await userEvent.click(screen.getByRole("switch", { name: "Use the router" }));
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Main model" }), "gpu:big-70b");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: /Sub-agent model/ }), "ollama:qwen3");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: /Fallback model/ }), "ollama:qwen3");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: /Canary model/ }), "ollama:qwen3-ft");
    const percent = screen.getByRole("spinbutton", { name: "Share of new tasks (%)" });
    await userEvent.clear(percent);
    await userEvent.type(percent, "15");
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    await userEvent.click(save);

    await waitFor(() => expect(bodies("/api/router", "PUT")).toHaveLength(1));
    expect(bodies("/api/router", "PUT")[0]).toEqual({
      enabled: true,
      main: { provider: "gpu", model: "big-70b" },
      subagent: { provider: "ollama", model: "qwen3" },
      judge: null,
      fallback: { provider: "ollama", model: "qwen3" },
      canary: { model: { provider: "ollama", model: "qwen3-ft" }, percent: 15 },
    });
    expect(await screen.findByText("Saved")).toBeInTheDocument();
    expect(screen.getByText("Auto currently means big-70b (GPU server).")).toBeInTheDocument();
  });

  it("explains router problems before saving", async () => {
    render(<ModelsTab connections={connections} />);
    await userEvent.click(await screen.findByRole("switch", { name: "Use the router" }));
    await userEvent.click(screen.getByRole("button", { name: "Save router" }));
    expect(screen.getByText("Choose a main model before turning the router on.")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Main model" })).toHaveAttribute("aria-invalid", "true");
    expect(bodies("/api/router", "PUT")).toHaveLength(0);
  });

  it("shows the server's message when it rejects the router settings", async () => {
    route({ saveRouter: () => jsonResponse({ error: "Choose a main model before turning the router on." }, 400) });
    render(<ModelsTab connections={connections} />);
    await userEvent.selectOptions(await screen.findByRole("combobox", { name: "Main model" }), "ollama:qwen3");
    await userEvent.click(screen.getByRole("switch", { name: "Use the router" }));
    await userEvent.click(screen.getByRole("button", { name: "Save router" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Choose a main model before turning the router on.");
    expect(screen.queryByText("Saved")).not.toBeInTheDocument();
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
  });
});
