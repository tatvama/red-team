// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as downloadFile } from "@/app/api/training/kits/[id]/files/[name]/route";
import { GET as listKits, POST as createKit } from "@/app/api/training/kits/route";
import type { FinetuneKitView } from "@/lib/contract";
import { closeDb } from "@/lib/server/db";
import { kitRequest, seedExport } from "@/lib/server/training/kit-fixtures";

// Fine-tuning kit routes, through the real handlers against a temporary DATA_DIR.

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "tatvam-kit-routes-"));
  vi.stubEnv("DATA_DIR", dir);
});
afterEach(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

const base = "http://127.0.0.1:3000";
const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request(`${base}/api/training/kits`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const file = (id: string, name: string) =>
  downloadFile(new Request(`${base}/api/training/kits/${id}/files/${encodeURIComponent(name)}`), {
    params: Promise.resolve({ id, name }),
  });

async function created(body: unknown): Promise<FinetuneKitView> {
  const response = await createKit(post(body));
  expect(response.status).toBe(201);
  expect(response.headers.get("cache-control")).toBe("no-store");
  return (await response.json()) as FinetuneKitView;
}

describe("fine-tuning kit routes", () => {
  it("creates a kit, lists it and serves its files as downloads", async () => {
    const exportId = seedExport({ dpoPairs: 2 });
    const kit = await created(kitRequest(exportId, { method: "sft_qlora" }));
    expect(kit.request).toMatchObject({ exportId, method: "sft_qlora", framework: "trl" });
    expect(kit.files.map((entry) => entry.name)).toContain("train.py");
    expect(kit.instructions).toContain("# Fine-tuning kit: tatvam-coder-v2");

    const second = await created(kitRequest(exportId, { method: "dpo_lora", framework: "axolotl", outputName: "tatvam-dpo" }));
    const list = (await (await listKits(new Request(`${base}/api/training/kits`))).json()) as { kits: FinetuneKitView[] };
    expect(list.kits.map((entry) => entry.id)).toEqual([second.id, kit.id]);

    const script = await file(kit.id, "train.py");
    expect(script.status).toBe(200);
    expect(script.headers.get("content-disposition")).toBe('attachment; filename="train.py"');
    expect(script.headers.get("cache-control")).toBe("no-store");
    expect(script.headers.get("x-content-type-options")).toBe("nosniff");
    const text = await script.text();
    expect(text).toContain("BitsAndBytesConfig(");
    expect(script.headers.get("content-length")).toBe(String(Buffer.byteLength(text)));

    // Nested data files are served by their recorded name, whether or not the slash arrives encoded.
    const expected = readFileSync(path.join(dir, "training", "exports", exportId, "sft_train.jsonl"), "utf8");
    for (const name of ["data/sft_train.jsonl", "data%2Fsft_train.jsonl"]) {
      const data = await file(kit.id, name);
      expect(data.status).toBe(200);
      expect(data.headers.get("content-disposition")).toBe('attachment; filename="sft_train.jsonl"');
      expect(await data.text()).toBe(expected);
    }
  });

  it("refuses names that are not recorded for the kit, including traversal", async () => {
    const kit = await created(kitRequest(seedExport()));
    const other = await created(kitRequest(seedExport({ dpoPairs: 1 }), { method: "dpo_lora" }));
    for (const name of [
      "tatvam.db",
      "../../tatvam.db",
      "..%2F..%2Ftatvam.db",
      "data/../train.py",
      "data%2F..%2F..%2F..%2Ftatvam.db",
      "%2Fetc%2Fpasswd",
      "C:%5CWindows%5Cwin.ini",
      "data/dpo.jsonl",
      "%E0%A4%A",
    ]) {
      const response = await file(kit.id, name);
      expect(response.status, name).toBe(404);
    }
    // A file of one kit is not reachable through another kit's id.
    expect((await file(kit.id, "data/dpo.jsonl")).status).toBe(404);
    expect((await file(other.id, "data/dpo.jsonl")).status).toBe(200);
    expect((await file("not-a-uuid", "train.py")).status).toBe(404);
    expect((await file(crypto.randomUUID(), "train.py")).status).toBe(404);
  });

  it("returns 404 for an unknown export and 400 for DPO without preference pairs", async () => {
    const unknown = await createKit(post(kitRequest(crypto.randomUUID())));
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as { error: string }).error).toMatch(/no longer exists/);

    const noPairs = await createKit(post(kitRequest(seedExport(), { method: "dpo_lora" })));
    expect(noPairs.status).toBe(400);
    expect(((await noPairs.json()) as { error: string }).error).toMatch(/preference pairs/);

    const list = (await (await listKits(new Request(`${base}/api/training/kits`))).json()) as { kits: FinetuneKitView[] };
    expect(list.kits).toEqual([]);
  });

  it("rejects invalid requests and cross-origin callers", async () => {
    const exportId = seedExport();
    const valid = kitRequest(exportId);
    for (const body of [
      { ...valid, outputName: "../escape" },
      { ...valid, baseModel: "model; rm -rf /" },
      { ...valid, method: "full_finetune" },
      { ...valid, extra: true },
      { ...valid, hyperparameters: { ...valid.hyperparameters, learningRate: 0 } },
      { ...valid, hyperparameters: { ...valid.hyperparameters, flags: "--trust-remote-code" } },
      "{not json",
    ])
      expect((await createKit(post(body))).status).toBe(400);
    expect((await createKit(post(valid, { origin: "https://evil.example" }))).status).toBe(403);
    expect((await listKits(new Request(`${base}/api/training/kits`, { headers: { origin: "https://evil.example" } }))).status).toBe(403);
  });
});
