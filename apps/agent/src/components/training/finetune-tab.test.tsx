import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatasetExportView, FinetuneKitRequest, FinetuneKitView } from "@/lib/contract";
import { datasetExport, finetuneKit, jsonResponse } from "@/test/fixtures";
import { defaultKitForm, FinetuneTab, validateKit } from "./finetune-tab";

vi.mock("@/lib/client/navigation", () => ({ navigateTo: vi.fn() }));

const EXPORT = datasetExport();
const NO_PAIRS = datasetExport({
  id: "77777777-0000-4000-8000-00000000000b",
  createdAt: "2026-10-09T12:00:00.000Z",
  stats: { ...EXPORT.stats, preferencePairs: 0 },
});

describe("FinetuneTab", () => {
  const fetchMock = vi.fn<typeof fetch>();
  let kits: FinetuneKitView[];

  beforeEach(() => {
    kits = [];
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/training/exports") return jsonResponse({ exports: [EXPORT, NO_PAIRS] });
      if (url === "/api/training/kits" && init?.method === "POST") {
        const request = JSON.parse(String(init.body)) as FinetuneKitRequest;
        return jsonResponse(finetuneKit({ request, path: `/data/training/kits/${request.outputName}` }));
      }
      if (url === "/api/training/kits") return jsonResponse({ kits });
      return jsonResponse({ error: "Not found" }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => fetchMock.mockReset());

  const posted = () =>
    fetchMock.mock.calls
      .filter(([url, init]) => url === "/api/training/kits" && init?.method === "POST")
      .map(([, init]) => JSON.parse(String(init?.body)) as unknown);

  it("starts with sensible hyperparameters and the newest export", async () => {
    render(<FinetuneTab />);
    expect(await screen.findByRole("combobox", { name: "Dataset export" })).toHaveValue(EXPORT.id);
    expect(screen.getByRole("textbox", { name: "Base model" })).toHaveValue("");
    expect(screen.getByRole("combobox", { name: "Method" })).toHaveValue("sft_lora");
    expect(screen.getByRole("radio", { name: "TRL" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("spinbutton", { name: "Epochs" })).toHaveValue(2);
    expect(screen.getByRole("textbox", { name: "Learning rate" })).toHaveValue("2e-4");
    expect(screen.getByRole("spinbutton", { name: "LoRA rank" })).toHaveValue(16);
    expect(screen.getByRole("spinbutton", { name: "LoRA alpha" })).toHaveValue(32);
    expect(screen.getByRole("spinbutton", { name: "Max sequence length" })).toHaveValue(4096);
    expect(screen.getByRole("spinbutton", { name: "Batch size" })).toHaveValue(2);
    expect(screen.getByRole("spinbutton", { name: "Gradient accumulation" })).toHaveValue(8);
    expect(screen.getByText("Effective batch size: 16.")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Output name" })).toHaveValue("tatvam-agent-lora");
  });

  it("validates the form before creating a kit", async () => {
    render(<FinetuneTab />);
    await screen.findByRole("combobox", { name: "Dataset export" });
    const epochs = screen.getByRole("spinbutton", { name: "Epochs" });
    await userEvent.clear(epochs);
    await userEvent.type(epochs, "0");
    const output = screen.getByRole("textbox", { name: "Output name" });
    await userEvent.clear(output);
    await userEvent.type(output, "My Model");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Dataset export" }), NO_PAIRS.id);
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Method" }), "dpo_lora");
    await userEvent.click(screen.getByRole("button", { name: "Create kit" }));

    expect(screen.getByText("Enter the base model: a Hugging Face repo id or a local path.")).toBeInTheDocument();
    expect(screen.getByText("Epochs must be from 0.1 to 20.")).toBeInTheDocument();
    expect(screen.getByText(/Start with a lowercase letter or digit/)).toBeInTheDocument();
    expect(screen.getByText(/This export has no preference pairs/)).toBeInTheDocument();
    expect(screen.getByRole("spinbutton", { name: "Epochs" })).toHaveAttribute("aria-invalid", "true");
    expect(posted()).toHaveLength(0);
  });

  it("creates a kit and lists it with instructions, its path and downloads", async () => {
    render(<FinetuneTab />);
    await screen.findByRole("combobox", { name: "Dataset export" });
    await userEvent.type(screen.getByRole("textbox", { name: "Base model" }), "Qwen/Qwen3-8B");
    await userEvent.click(screen.getByRole("radio", { name: "Axolotl" }));
    await userEvent.click(screen.getByRole("button", { name: "Create kit" }));

    await waitFor(() => expect(posted()).toHaveLength(1));
    expect(posted()[0]).toEqual({
      exportId: EXPORT.id,
      baseModel: "Qwen/Qwen3-8B",
      method: "sft_lora",
      framework: "axolotl",
      hyperparameters: {
        epochs: 2,
        learningRate: 0.0002,
        loraRank: 16,
        loraAlpha: 32,
        maxSeqLength: 4096,
        batchSize: 2,
        gradientAccumulation: 8,
      },
      outputName: "tatvam-agent-lora",
    });

    const card = (await screen.findByRole("heading", { name: "tatvam-agent-lora" })).closest("article") as HTMLElement;
    expect(within(card).getByText("/data/training/kits/tatvam-agent-lora")).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "Copy the path of tatvam-agent-lora" })).toBeInTheDocument();
    expect(within(card).getByRole("heading", { name: "Run it" })).toBeInTheDocument();
    expect(within(card).getByText("python train.py", { selector: "code" })).toBeInTheDocument();
    expect(within(card).getByRole("link", { name: "Download train.py" })).toHaveAttribute(
      "href",
      `/api/training/kits/${finetuneKit().id}/files/train.py`,
    );
  });
});

describe("validateKit", () => {
  const exportsList: DatasetExportView[] = [EXPORT];

  it("accepts the defaults once an export and a base model are chosen", () => {
    const { errors, request } = validateKit({ ...defaultKitForm, exportId: EXPORT.id, baseModel: "/models/qwen3" }, exportsList);
    expect(errors).toEqual({});
    expect(request?.hyperparameters.learningRate).toBe(0.0002);
  });

  it("rejects out-of-range and fractional values", () => {
    const { errors, request } = validateKit(
      {
        ...defaultKitForm,
        exportId: EXPORT.id,
        baseModel: "bad model name",
        learningRate: "0",
        loraRank: "16.5",
        maxSeqLength: "100",
        batchSize: "",
      },
      exportsList,
    );
    expect(request).toBeNull();
    expect(Object.keys(errors).sort()).toEqual(["baseModel", "batchSize", "learningRate", "loraRank", "maxSeqLength"]);
    expect(errors.learningRate).toBe("Learning rate must be above 0 and at most 0.01.");
    expect(errors.loraRank).toBe("LoRA rank must be a whole number from 4 to 256.");
  });
});
