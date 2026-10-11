// @vitest-environment node
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { load } from "js-yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerModelSchema, type FinetuneKitRequest } from "@/lib/contract";
import { closeDb, database } from "../db";
import { kitRequest, seedExport } from "./kit-fixtures";
import { guessToolCallParser, parameterBillions, vllmMaxLoraRank, yamlNum } from "./kit-templates";
import { createKit, getKit, KitError, kitDir, kitFile, listKits } from "./kits";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "tatvam-kits-"));
  vi.stubEnv("DATA_DIR", dir);
});
afterEach(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

const read = (kitId: string, name: string) => readFileSync(path.join(kitDir(kitId), ...name.split("/")), "utf8");

async function expectKitError(work: Promise<unknown>, status: number, message: RegExp) {
  const error = await work.then(
    () => null,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(KitError);
  expect((error as KitError).status).toBe(status);
  expect((error as KitError).message).toMatch(message);
}

const combinations: [FinetuneKitRequest["method"], FinetuneKitRequest["framework"]][] = [
  ["sft_lora", "trl"],
  ["sft_qlora", "trl"],
  ["dpo_lora", "trl"],
  ["sft_lora", "axolotl"],
  ["sft_qlora", "axolotl"],
  ["dpo_lora", "axolotl"],
];

describe("fine-tuning kits", () => {
  it.each(combinations)("generates a complete %s kit for %s", async (method, framework) => {
    const exportId = seedExport({ dpoPairs: 4 });
    const kit = await createKit(kitRequest(exportId, { method, framework }));

    const trainer = framework === "trl" ? ["train.py"] : method === "dpo_lora" ? ["axolotl.yaml", "prepare_dpo.py"] : ["axolotl.yaml"];
    const expected = [
      "README.md",
      "requirements.txt",
      ...trainer,
      "run.sh",
      "merge_lora.py",
      "serve_vllm.sh",
      "register.json",
      "data/sft_train.jsonl",
      "data/sft_eval.jsonl",
      "data/dpo.jsonl",
      "data/manifest.json",
    ];
    expect(kit.files.map((file) => file.name)).toEqual(expected);
    expect(kit.path).toBe(kitDir(kit.id));
    for (const file of kit.files) expect(readFileSync(path.join(kit.path, ...file.name.split("/"))).length).toBe(file.bytes);
    // The export's own README stays behind; the dataset files are byte-for-byte copies.
    expect(existsSync(path.join(kit.path, "data", "README.md"))).toBe(false);
    const exportFolder = path.join(dir, "training", "exports", exportId);
    expect(read(kit.id, "data/sft_train.jsonl")).toBe(readFileSync(path.join(exportFolder, "sft_train.jsonl"), "utf8"));

    const requirements = read(kit.id, "requirements.txt");
    for (const name of ["torch", "transformers", "datasets", "accelerate", "peft", "trl"]) expect(requirements).toMatch(new RegExp(`^${name}>=`, "m"));
    expect(requirements.includes("bitsandbytes>=")).toBe(method === "sft_qlora");
    expect(requirements.includes("axolotl>=")).toBe(framework === "axolotl");

    if (framework === "trl") {
      const script = read(kit.id, "train.py");
      expect(script).toContain('BASE_MODEL = setting("BASE_MODEL", "Qwen/Qwen3-8B")');
      expect(script).toContain('OUTPUT_NAME = setting("OUTPUT_NAME", "tatvam-coder-v2")');
      expect(script).toContain('EPOCHS = setting("EPOCHS", 2.5, float)');
      expect(script).toContain('LEARNING_RATE = setting("LEARNING_RATE", 0.00007, float)');
      expect(script).toContain('LORA_RANK = setting("LORA_RANK", 24, int)');
      expect(script).toContain('LORA_ALPHA = setting("LORA_ALPHA", 48, int)');
      expect(script).toContain('MAX_SEQ_LENGTH = setting("MAX_SEQ_LENGTH", 6144, int)');
      expect(script).toContain('BATCH_SIZE = setting("BATCH_SIZE", 2, int)');
      expect(script).toContain('GRADIENT_ACCUMULATION = setting("GRADIENT_ACCUMULATION", 6, int)');
      expect(script).toContain('load_dataset("json", data_files=path, split="train")');
      expect(script).toContain("LoraConfig(");
      if (method === "dpo_lora") {
        expect(script).toContain("from trl import DPOConfig, DPOTrainer");
        expect(script).toContain('TRAIN_FILE = "data/dpo.jsonl"');
        expect(script).not.toContain("SFTTrainer");
      } else {
        expect(script).toContain("from trl import SFTConfig, SFTTrainer");
        expect(script).toContain('TRAIN_FILE = "data/sft_train.jsonl"');
        expect(script).toContain('EVAL_FILE = "data/sft_eval.jsonl"');
      }
      expect(script.includes("BitsAndBytesConfig(")).toBe(method === "sft_qlora");
      expect(script.includes("load_in_4bit=True")).toBe(method === "sft_qlora");
      expect(read(kit.id, "run.sh")).toContain("python train.py");
    } else {
      const config = load(read(kit.id, "axolotl.yaml")) as Record<string, unknown> & { datasets: Record<string, unknown>[] };
      expect(config).toMatchObject({
        base_model: "Qwen/Qwen3-8B",
        chat_template: "tokenizer_default",
        adapter: method === "sft_qlora" ? "qlora" : "lora",
        lora_r: 24,
        lora_alpha: 48,
        sequence_len: 6144,
        num_epochs: 2.5,
        learning_rate: 0.00007,
        micro_batch_size: 2,
        gradient_accumulation_steps: 6,
        output_dir: "./output/tatvam-coder-v2",
      });
      expect(config.load_in_4bit === true).toBe(method === "sft_qlora");
      if (method === "dpo_lora") {
        expect(config.rl).toBe("dpo");
        expect(config.datasets[0]).toMatchObject({ path: "data/dpo_axolotl.jsonl", type: "chat_template.default" });
        expect(read(kit.id, "prepare_dpo.py")).toContain('SOURCE = "data/dpo.jsonl"');
        expect(read(kit.id, "run.sh")).toContain("python prepare_dpo.py");
      } else {
        expect(config.datasets[0]).toMatchObject({ path: "data/sft_train.jsonl", type: "chat_template", field_messages: "messages" });
        expect((config.test_datasets as Record<string, unknown>[])[0]).toMatchObject({ path: "data/sft_eval.jsonl" });
      }
      expect(read(kit.id, "run.sh")).toContain("axolotl train axolotl.yaml");
    }

    const runScript = read(kit.id, "run.sh");
    expect(runScript).toContain('"$PYTHON" -m venv "$VENV_DIR"');
    expect(runScript).toContain("pip install -r requirements.txt");

    const merge = read(kit.id, "merge_lora.py");
    expect(merge).toContain("PeftModel.from_pretrained");
    expect(merge).toContain("merge_and_unload()");
    expect(merge).toContain('os.path.join("merged", OUTPUT_NAME)');
    expect(merge).toContain('OUTPUT_NAME = setting("OUTPUT_NAME", "tatvam-coder-v2")');

    const serve = read(kit.id, "serve_vllm.sh");
    expect(serve).toContain('--enable-lora --lora-modules "$NAME=./output/$NAME"');
    expect(serve).toContain('NAME="tatvam-coder-v2"');
    expect(serve).toContain('--served-model-name "$NAME"');
    expect(serve).toContain("--max-lora-rank 32");
    expect(serve).toContain("VLLM_API_KEY");
    expect(serve).not.toContain("--api-key");

    const register = registerModelSchema.parse(JSON.parse(read(kit.id, "register.json")));
    expect(register).toMatchObject({ provider: "gpu", modelId: "tatvam-coder-v2", kind: "finetune", status: "candidate", datasetExportId: exportId, parentId: null });

    const readme = read(kit.id, "README.md");
    expect(kit.instructions).toBe(readme);
    for (const step of ["Copy the kit to the GPU server", "Train", "Merge the adapter", "Serve it with vLLM", "Register the model", "Evaluate it against the baseline", "Canary it through the router", "Promote or retire"])
      expect(readme).toContain(step);
    expect(readme).toContain(kit.path);

    const row = database().prepare("SELECT * FROM finetune_kits WHERE id = ?").get(kit.id) as Record<string, string>;
    expect(JSON.parse(row.request)).toEqual(kit.request);
    expect(JSON.parse(row.files)).toEqual(kit.files);
    expect(row.instructions).toBe(readme);
    expect(getKit(kit.id)).toEqual(kit);
  });

  it("leaves the eval file out of the trainer when the export has no held-out split", async () => {
    const kit = await createKit(kitRequest(seedExport({ evalSplit: false })));
    expect(kit.files.map((file) => file.name)).not.toContain("data/sft_eval.jsonl");
    expect(read(kit.id, "train.py")).toContain("EVAL_FILE = None");
    const axolotl = await createKit(kitRequest(seedExport({ evalSplit: false }), { framework: "axolotl" }));
    expect((load(read(axolotl.id, "axolotl.yaml")) as Record<string, unknown>).test_datasets).toBeUndefined();
  });

  it("refuses DPO when the export has no preference pairs", async () => {
    const withoutFile = seedExport();
    await expectKitError(createKit(kitRequest(withoutFile, { method: "dpo_lora" })), 400, /preference pairs/);
    const emptyFile = seedExport({ dpoPairs: 0 });
    await expectKitError(createKit(kitRequest(emptyFile, { method: "dpo_lora", framework: "axolotl" })), 400, /preference pairs/);
    expect(existsSync(path.join(dir, "training", "kits")) ? readdirSync(path.join(dir, "training", "kits")) : []).toEqual([]);
    expect(listKits()).toEqual([]);
  });

  it("refuses SFT when the export has no training examples", async () => {
    await expectKitError(createKit(kitRequest(seedExport({ trainExamples: 0, dpoPairs: 2 }))), 400, /training examples/);
  });

  it("returns 404 for an unknown export or one whose files are gone", async () => {
    await expectKitError(createKit(kitRequest(crypto.randomUUID())), 404, /no longer exists/);
    await expectKitError(createKit(kitRequest(seedExport({ noFiles: true }))), 404, /missing/);
  });

  it("links register.json to a registered base model and marks distilled datasets", async () => {
    database()
      .prepare(
        `INSERT INTO registered_models (id, provider, model_id, label, kind, status, notes, created_at)
         VALUES ('5b1a7d1e-0000-4000-8000-000000000001', 'gpu', 'Qwen/Qwen3-8B', 'Qwen3 8B', 'base', 'active', '', ?)`,
      )
      .run(new Date().toISOString());
    const kit = await createKit(kitRequest(seedExport({ kinds: ["distill"] })));
    expect(JSON.parse(read(kit.id, "register.json"))).toMatchObject({
      parentId: "5b1a7d1e-0000-4000-8000-000000000001",
      kind: "distilled",
    });
  });

  it("lists kits newest first", async () => {
    const exportId = seedExport();
    const first = await createKit(kitRequest(exportId, { outputName: "first" }));
    const second = await createKit(kitRequest(exportId, { outputName: "second" }));
    database().prepare("UPDATE finetune_kits SET created_at = ? WHERE id = ?").run("2026-01-01T00:00:00.000Z", first.id);
    expect(listKits().map((kit) => kit.request.outputName)).toEqual(["second", "first"]);
    expect(second.id).not.toBe(first.id);
  });

  it("resolves only recorded file names inside the kit", async () => {
    const kit = await createKit(kitRequest(seedExport()));
    expect(kitFile(kit.id, "train.py")).toMatchObject({ name: "train.py", path: path.join(kit.path, "train.py") });
    expect(kitFile(kit.id, "data/sft_train.jsonl")).toMatchObject({ path: path.join(kit.path, "data", "sft_train.jsonl") });
    for (const name of ["tatvam.db", "../../tatvam.db", "data/../train.py", "/etc/passwd", "data\\sft_train.jsonl", "data", ""])
      expect(kitFile(kit.id, name)).toBeNull();
    expect(kitFile(crypto.randomUUID(), "train.py")).toBeNull();
  });
});

describe("kit template helpers", () => {
  it("formats YAML numbers so PyYAML reads them as numbers", async () => {
    expect(yamlNum(5e-7)).toBe("5.0e-7");
    expect(yamlNum(0.0002)).toBe("0.0002");
    expect(yamlNum(3)).toBe("3");
    const kit = await createKit(kitRequest(seedExport(), { framework: "axolotl", hyperparameters: { ...kitRequest("").hyperparameters, learningRate: 5e-7 } }));
    expect(read(kit.id, "axolotl.yaml")).toContain("learning_rate: 5.0e-7");
  });

  it("guesses serving settings from the model name", () => {
    expect(vllmMaxLoraRank(12)).toBe(16);
    expect(vllmMaxLoraRank(64)).toBe(64);
    expect(vllmMaxLoraRank(200)).toBe(256);
    expect(guessToolCallParser("meta-llama/Llama-3.1-8B-Instruct")).toBe("llama3_json");
    expect(guessToolCallParser("Qwen/Qwen3-Coder-30B-A3B-Instruct")).toBe("qwen3_coder");
    expect(guessToolCallParser("Qwen/Qwen2.5-7B-Instruct")).toBe("hermes");
    expect(parameterBillions("Qwen/Qwen2.5-Coder-32B-Instruct")).toBe(32);
    expect(parameterBillions("meta-llama/Llama-3.1-70B")).toBe(70);
    expect(parameterBillions("openai/gpt-oss-20b")).toBe(20);
    expect(parameterBillions("microsoft/phi-4")).toBeNull();
  });
});
