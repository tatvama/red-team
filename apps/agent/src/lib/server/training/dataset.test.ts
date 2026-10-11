// @vitest-environment node
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationKind, DatasetExportRequest, DatasetExportView, TrainingStatus } from "@/lib/contract";
import * as db from "../db";
import type { WireMessage } from "../llm";
import {
  createDatasetExport,
  DatasetExportError,
  deleteDatasetExport,
  exampleHash,
  exportFile,
  getDatasetExport,
  listDatasetExports,
  MINIMAL_SYSTEM_PROMPT,
  splitBucket,
  trainingSystemPrompt,
  type PreferencePair,
  type SftExample,
} from "./dataset";
import { REDACTION_PLACEHOLDERS as P } from "./redact";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "tatvam-dataset-"));
  vi.stubEnv("DATA_DIR", dir);
  vi.stubEnv("WORKSPACE_DIR", "");
});
afterEach(() => {
  db.closeDb();
  rmSync(dir, { recursive: true, force: true });
});

// ── Builders ─────────────────────────────────────────────────────────────────

function conversation(options: { status?: TrainingStatus; kind?: ConversationKind } = {}): string {
  return db.createConversation({
    title: "t",
    provider: "ollama",
    model: "qwen3",
    permissionMode: "ask",
    kind: options.kind,
    trainingStatus: options.status ?? "approved",
  }).id;
}
const user = (id: string, content: string) => db.appendMessage(id, { role: "user", content });
function reply(
  id: string,
  content: string,
  extra: { toolCalls?: db.StoredToolCall[]; interrupted?: boolean; reasoning?: string } = {},
) {
  return db.appendMessage(id, {
    role: "assistant",
    content,
    reasoning: extra.reasoning ?? "",
    toolCalls: extra.toolCalls ?? [],
    model: "qwen3",
    interrupted: extra.interrupted ?? false,
  });
}
const toolResult = (id: string, toolCallId: string, content: string, status: "ok" | "error" = "ok") =>
  db.appendMessage(id, { role: "tool", toolCallId, content, status });
function rate(
  conversationId: string,
  messageId: string,
  rating: "up" | "down" | null,
  correction: string | null = null,
  toolCallId: string | null = null,
) {
  db.saveFeedback(conversationId, { messageId, toolCallId, rating, correction, note: null });
}
/** A one-turn conversation; returns the conversation and reply ids. */
function chat(question: string, answer: string, options: { status?: TrainingStatus; kind?: ConversationKind } = {}) {
  const id = conversation(options);
  user(id, question);
  return { id, replyId: reply(id, answer).id };
}

const request = (overrides: Partial<DatasetExportRequest> = {}): DatasetExportRequest => ({
  statuses: ["approved"],
  kinds: ["chat"],
  requirePositiveFeedback: false,
  redactPii: false,
  evalFraction: 0,
  systemPrompt: "minimal",
  ...overrides,
});

const folder = (view: DatasetExportView) => path.join(dir, "training", "exports", view.id);
const readText = (view: DatasetExportView, name: string) => readFileSync(path.join(folder(view), name), "utf8");
function readJsonl<T>(view: DatasetExportView, name: string): T[] {
  const text = readText(view, name);
  if (!text) return [];
  expect(text.endsWith("\n")).toBe(true);
  return text
    .slice(0, -1)
    .split("\n")
    .map((line) => JSON.parse(line) as T);
}
const examples = (view: DatasetExportView, name = "sft_train.jsonl") => readJsonl<SftExample>(view, name);
const system = { role: "system", content: MINIMAL_SYSTEM_PROMPT };

// ── Tests ────────────────────────────────────────────────────────────────────

describe("selection", () => {
  it("exports conversations that match the statuses and kinds", async () => {
    chat("approved chat", "yes");
    chat("unreviewed chat", "no", { status: "unreviewed" });
    chat("excluded chat", "no", { status: "excluded" });
    chat("approved eval", "maybe", { kind: "eval" });
    chat("approved distill", "maybe", { kind: "distill" });

    const onlyChats = await createDatasetExport(request());
    expect(onlyChats.stats).toMatchObject({ conversations: 1, sftTrain: 1, sftEval: 0, preferencePairs: 0, skipped: {} });
    expect(examples(onlyChats).map((example) => example.messages[1].content)).toEqual(["approved chat"]);

    const wider = await createDatasetExport(request({ statuses: ["approved", "unreviewed"], kinds: ["chat", "eval"] }));
    expect(examples(wider).map((example) => example.messages[1].content).sort()).toEqual([
      "approved chat",
      "approved eval",
      "unreviewed chat",
    ]);
    expect(listDatasetExports().map((item) => item.id)).toEqual([wider.id, onlyChats.id]);
    expect(getDatasetExport(onlyChats.id)).toEqual(onlyChats);
  });

  it("records every skip reason", async () => {
    // no_assistant_reply: only a user message, or only an empty reply.
    user(conversation(), "hello?");
    const empty = conversation();
    user(empty, "hello?");
    reply(empty, "  ");
    // interrupted: the last reply was stopped.
    const stopped = conversation();
    user(stopped, "write a poem");
    reply(stopped, "Roses are", { interrupted: true });
    // invalid_tool_calls: one per error message the agent writes.
    for (const [index, output] of [
      'Unknown tool "teleport". Use only the tools you were given.',
      "The arguments were not valid JSON. Send a single JSON object.",
      "Invalid arguments: ✖ Required → at path",
    ].entries()) {
      const id = conversation();
      user(id, `task ${index}`);
      reply(id, "", { toolCalls: [{ id: `call_${index}`, name: "read_file", arguments: "{" }] });
      toolResult(id, `call_${index}`, output, "error");
      reply(id, "Done.");
    }
    // negative_feedback: a thumbs-down without a correction, on the reply or on one of its tool calls.
    const disliked = chat("q", "bad answer");
    rate(disliked.id, disliked.replyId, "down");
    const badCall = conversation();
    user(badCall, "list files");
    const withCall = reply(badCall, "", { toolCalls: [{ id: "call_x", name: "list_files", arguments: "{}" }] });
    toolResult(badCall, "call_x", "a.ts");
    reply(badCall, "One file.");
    rate(badCall, withCall.id, "down", null, "call_x");

    const view = await createDatasetExport(request());
    expect(view.stats.skipped).toEqual({ no_assistant_reply: 2, interrupted: 1, invalid_tool_calls: 3, negative_feedback: 2 });
    expect(view.stats.conversations).toBe(0);
    expect(view.files.map((file) => [file.name, file.records])).toEqual([
      ["sft_train.jsonl", 0],
      ["sft_eval.jsonl", 0],
      ["README.md", 0],
      ["manifest.json", 0],
    ]);
  });

  it("keeps a corrected invalid tool call or thumbs-down, and requires a thumbs-up when asked", async () => {
    const fixed = conversation();
    user(fixed, "read it");
    const bad = reply(fixed, "", { toolCalls: [{ id: "call_1", name: "teleport", arguments: "{}" }] });
    toolResult(fixed, "call_1", 'Unknown tool "teleport".', "error");
    rate(fixed, bad.id, "down", "I can't teleport, but I can read the file with read_file.");

    const liked = chat("liked", "good");
    rate(liked.id, liked.replyId, "up");
    chat("unrated", "fine");
    const mixed = conversation();
    user(mixed, "two questions");
    const first = reply(mixed, "first");
    user(mixed, "and?");
    const second = reply(mixed, "second");
    rate(mixed, first.id, "up");
    rate(mixed, second.id, "down");

    const open = await createDatasetExport(request());
    expect(open.stats).toMatchObject({ conversations: 3, skipped: { negative_feedback: 1 } });

    const strict = await createDatasetExport(request({ requirePositiveFeedback: true }));
    expect(strict.stats).toMatchObject({ conversations: 1, skipped: { no_positive_feedback: 2, negative_feedback: 1 } });
    expect(examples(strict)[0].messages.at(-1)).toEqual({ role: "assistant", content: "good" });
  });

  it("ignores feedback left on messages that a rewind deleted", async () => {
    const { id } = chat("q", "a");
    user(id, "more");
    const gone = reply(id, "removed later");
    rate(id, gone.id, "down");
    db.deleteMessagesFrom(id, 3);
    const view = await createDatasetExport(request());
    expect(view.stats).toMatchObject({ conversations: 1, skipped: {} });
  });
});

describe("SFT examples", () => {
  it("formats tool calls in OpenAI chat format, drops reasoning and dropped replies, and lists the used tools", async () => {
    const id = conversation();
    user(id, "What is in src?");
    // An interrupted attempt with a call: dropped together with its result.
    reply(id, "Let me", { interrupted: true, toolCalls: [{ id: "call_0", name: "list_files", arguments: '{"path":"."}' }] });
    toolResult(id, "call_0", "Stopped by the user.", "error");
    reply(id, "");
    reply(id, "", {
      reasoning: "I should look.",
      toolCalls: [
        { id: "call_1", name: "list_files", arguments: '{"path":"src"}' },
        { id: "call_2", name: "read_file", arguments: '{"path":"src/a.ts"}' },
      ],
    });
    toolResult(id, "call_1", "a.ts");
    toolResult(id, "call_2", "export const a = 1;");
    reply(id, "src holds a.ts, which exports `a`.", { reasoning: "Summarize." });
    user(id, "thanks");

    const view = await createDatasetExport(request());
    const [example] = examples(view);
    expect(example.messages).toEqual([
      system,
      { role: "user", content: "What is in src?" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "list_files", arguments: '{"path":"src"}' } },
          { id: "call_2", type: "function", function: { name: "read_file", arguments: '{"path":"src/a.ts"}' } },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "a.ts" },
      { role: "tool", tool_call_id: "call_2", content: "export const a = 1;" },
      { role: "assistant", content: "src holds a.ts, which exports `a`." },
    ]);
    expect(example.tools.map((tool) => tool.function.name)).toEqual(["list_files", "read_file"]);
    expect(example.tools[0]).toMatchObject({ type: "function", function: { parameters: { type: "object" } } });
    expect(example.tools[0].function.parameters).not.toHaveProperty("$schema");
    expect(readText(view, "sft_train.jsonl")).not.toContain("reasoning");
  });

  it("gives a call without a recorded result a placeholder result", async () => {
    const id = conversation();
    user(id, "delete it");
    reply(id, "", { toolCalls: [{ id: "call_1", name: "run_command", arguments: '{"command":"rm x"}' }] });
    const [example] = examples(await createDatasetExport(request()));
    expect(example.messages.slice(2)).toEqual([
      { role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "run_command", arguments: '{"command":"rm x"}' } }] },
      { role: "tool", tool_call_id: "call_1", content: "No result (interrupted)." },
    ]);
    expect(example.tools.map((tool) => tool.function.name)).toEqual(["run_command"]);
  });

  it("replaces a corrected reply, without its tool calls, and ends the example there", async () => {
    const id = conversation();
    user(id, "Q1");
    reply(id, "A1");
    user(id, "Q2");
    const corrected = reply(id, "", { toolCalls: [{ id: "call_1", name: "web_search", arguments: '{"query":"x"}' }] });
    toolResult(id, "call_1", "results");
    reply(id, "A2 after search");
    user(id, "Q3");
    reply(id, "A3");
    rate(id, corrected.id, "down", "  A2, answered directly.  ");

    const view = await createDatasetExport(request());
    expect(examples(view)[0]).toEqual({
      messages: [
        system,
        { role: "user", content: "Q1" },
        { role: "assistant", content: "A1" },
        { role: "user", content: "Q2" },
        { role: "assistant", content: "A2, answered directly." },
      ],
      tools: [],
    });
    // The original had tool calls, so it makes no preference pair.
    expect(view.stats.preferencePairs).toBe(0);
    expect(view.files.map((file) => file.name)).not.toContain("dpo.jsonl");
    expect(existsSync(path.join(folder(view), "dpo.jsonl"))).toBe(false);
  });

  it("uses the agent system prompt without the date, mode, memories or instructions", async () => {
    db.addMemory("The user likes tabs");
    db.saveSettings({ instructions: "Always answer in French", toolPolicies: {} });
    chat("hi", "hello");
    const view = await createDatasetExport(request({ systemPrompt: "agent" }));
    const prompt = examples(view)[0].messages[0];
    expect(prompt).toEqual({ role: "system", content: trainingSystemPrompt("agent") });
    expect(prompt.content).toMatch(/^You are Tatvam/);
    expect(prompt.content).toContain("How to work:");
    expect(prompt.content).toContain("Rules:");
    expect(prompt.content).not.toMatch(/Current date|Permission mode|\d{4}-\d{2}-\d{2}|tabs|French/);
    expect(trainingSystemPrompt("minimal")).toBe("You are Tatvam, a helpful AI assistant.");
  });
});

describe("preference pairs", () => {
  it("pairs each corrected text reply with the conversation before it", async () => {
    const id = conversation();
    user(id, "Q1");
    const first = reply(id, "A1 wrong");
    user(id, "Q2");
    reply(id, "", { toolCalls: [{ id: "call_1", name: "calculator", arguments: '{"expression":"2+2"}' }] });
    toolResult(id, "call_1", "4");
    const second = reply(id, "A2 wrong");
    rate(id, first.id, "down", "A1 right");
    rate(id, second.id, null, "A2 right");
    // A correction identical to the original, ignoring case and spacing, is not a preference.
    const same = chat("Q", "Same  answer");
    rate(same.id, same.replyId, null, "same answer");

    const view = await createDatasetExport(request());
    const pairs = readJsonl<PreferencePair>(view, "dpo.jsonl");
    expect(pairs).toEqual([
      {
        prompt: [system, { role: "user", content: "Q1" }],
        chosen: [{ role: "assistant", content: "A1 right" }],
        rejected: [{ role: "assistant", content: "A1 wrong" }],
      },
      {
        prompt: [
          system,
          { role: "user", content: "Q1" },
          { role: "assistant", content: "A1 wrong" },
          { role: "user", content: "Q2" },
          { role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "calculator", arguments: '{"expression":"2+2"}' } }] },
          { role: "tool", tool_call_id: "call_1", content: "4" },
        ],
        chosen: [{ role: "assistant", content: "A2 right" }],
        rejected: [{ role: "assistant", content: "A2 wrong" }],
      },
    ]);
    expect(view.stats.preferencePairs).toBe(2);
    expect(view.files.find((file) => file.name === "dpo.jsonl")).toMatchObject({ records: 2 });
    // The SFT example stops at the first correction.
    const sft = examples(view).find((example) => example.messages[1].content === "Q1")!;
    expect(sft.messages.slice(1)).toEqual([
      { role: "user", content: "Q1" },
      { role: "assistant", content: "A1 right" },
    ]);
  });
});

describe("redaction", () => {
  const key = `sk-${"aB3dE5fG7hJ9".repeat(4)}`;

  function seedSecrets() {
    const id = conversation();
    const workspace = path.join(dir, "workspace");
    user(id, `My key is ${key}, mail me at alice@example.com`);
    reply(id, "", {
      toolCalls: [
        {
          id: "call_1",
          name: "write_file",
          arguments: JSON.stringify({ path: path.join(workspace, ".env"), content: "DB_PASSWORD=hunter2\n" }),
        },
      ],
    });
    toolResult(id, "call_1", `Wrote ${path.join(workspace, ".env")}`);
    reply(id, "Saved. Authorization: Bearer abcdefghijklmnop1234567890");
  }

  it("masks secrets and paths in messages and tool arguments, and counts them", async () => {
    seedSecrets();
    const view = await createDatasetExport(request());
    const [example] = examples(view);
    expect(example.messages.slice(1)).toEqual([
      { role: "user", content: `My key is ${P.api_key}, mail me at alice@example.com` },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "write_file", arguments: JSON.stringify({ path: "/workspace/.env", content: `DB_PASSWORD=${P.secret}\n` }) },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "Wrote /workspace/.env" },
      { role: "assistant", content: `Saved. Authorization: Bearer ${P.bearer_token}` },
    ]);
    expect(view.stats.redactions).toEqual({ api_key: 1, secret: 1, path: 2, bearer_token: 1 });
    const everything = readdirSync(folder(view)).map((name) => readText(view, name)).join("\n");
    expect(everything).not.toContain(key);
    expect(everything).not.toContain("hunter2");
    expect(everything).not.toContain(dir);
    expect(everything).not.toContain(JSON.stringify(dir).slice(1, -1));
  });

  it("masks personal data only when asked", async () => {
    seedSecrets();
    const view = await createDatasetExport(request({ redactPii: true }));
    expect(examples(view)[0].messages[1].content).toBe(`My key is ${P.api_key}, mail me at ${P.email}`);
    expect(view.stats.redactions).toMatchObject({ email: 1 });
  });
});

describe("deduplication and split", () => {
  it("drops examples whose normalized user and assistant text is the same", async () => {
    chat("How do I list files?", "Use ls.");
    chat("  how do I   LIST files? ", "use ls.\n");
    chat("How do I list files?", "Use dir.");
    const view = await createDatasetExport(request());
    expect(view.stats).toMatchObject({ conversations: 3, sftTrain: 2, duplicatesDropped: 1 });
  });

  it("hashes only the user and assistant text, including tool calls", () => {
    const base: WireMessage[] = [
      { role: "system", content: "a" },
      { role: "user", content: "Hi  there" },
      { role: "assistant", content: "Hello", tool_calls: [{ id: "1", type: "function", function: { name: "f", arguments: "{}" } }] },
    ];
    const variant: WireMessage[] = [
      { role: "system", content: "b" },
      { role: "user", content: "hi there" },
      { role: "assistant", content: "hello ", tool_calls: [{ id: "2", type: "function", function: { name: "f", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "2", content: "different output" },
    ];
    expect(exampleHash(variant)).toBe(exampleHash(base));
    expect(exampleHash([...base.slice(0, 2), { role: "assistant", content: "Hello" }])).not.toBe(exampleHash(base));
  });

  it("splits deterministically by example hash", async () => {
    for (let index = 0; index < 60; index++) chat(`question ${index}`, `answer ${index}`);
    const first = await createDatasetExport(request({ evalFraction: 0.25 }));
    const second = await createDatasetExport(request({ evalFraction: 0.25 }));
    const questions = (view: DatasetExportView, name: string) => examples(view, name).map((example) => example.messages[1].content).sort();

    expect(first.stats.sftTrain + first.stats.sftEval).toBe(60);
    expect(first.stats.sftEval).toBeGreaterThanOrEqual(5);
    expect(first.stats.sftEval).toBeLessThanOrEqual(25);
    expect(questions(second, "sft_eval.jsonl")).toEqual(questions(first, "sft_eval.jsonl"));
    expect(questions(second, "sft_train.jsonl")).toEqual(questions(first, "sft_train.jsonl"));
    for (const example of examples(first, "sft_eval.jsonl")) expect(splitBucket(exampleHash(example.messages))).toBeLessThan(0.25);
    for (const example of examples(first)) expect(splitBucket(exampleHash(example.messages))).toBeGreaterThanOrEqual(0.25);

    const none = await createDatasetExport(request({ evalFraction: 0 }));
    expect(none.stats).toMatchObject({ sftTrain: 60, sftEval: 0 });
  });
});

describe("files", () => {
  it("writes JSONL that parses line by line, a manifest and a dataset card", async () => {
    const corrected = chat("Explain closures", "They are functions.");
    rate(corrected.id, corrected.replyId, "down", "A closure is a function that keeps access to the variables of the scope it was created in.");
    chat("Ping", "Pong");
    chat("Line\nbreaks and \"quotes\"", "Unicode ✓ and \\ backslashes");
    const view = await createDatasetExport(request({ evalFraction: 0.5, redactPii: true }));

    expect(view.files.map((file) => file.name)).toEqual(["sft_train.jsonl", "sft_eval.jsonl", "dpo.jsonl", "README.md", "manifest.json"]);
    for (const file of view.files) {
      const text = readText(view, file.name);
      expect(Buffer.byteLength(text, "utf8"), file.name).toBe(file.bytes);
      if (file.name.endsWith(".jsonl")) expect(readJsonl(view, file.name), file.name).toHaveLength(file.records);
    }
    expect(view.stats.sftTrain + view.stats.sftEval).toBe(3);
    expect(examples(view).concat(examples(view, "sft_eval.jsonl")).map((example) => example.messages.at(-1)!.content)).toContain(
      "Unicode ✓ and \\ backslashes",
    );

    const manifest = JSON.parse(readText(view, "manifest.json"));
    expect(manifest).toMatchObject({
      format: "tatvam-dataset",
      id: view.id,
      createdAt: view.createdAt,
      request: view.request,
      stats: view.stats,
      selectedConversations: 3,
      systemPrompt: MINIMAL_SYSTEM_PROMPT,
    });
    expect(manifest.files.map((file: { name: string }) => file.name)).toEqual(["sft_train.jsonl", "sft_eval.jsonl", "dpo.jsonl", "README.md"]);
    expect(manifest.notes.redaction.placeholders.email).toBe("[REDACTED_EMAIL]");

    const readme = readText(view, "README.md");
    expect(readme).toMatch(/^---\n/);
    expect(readme).toContain("config_name: dpo");
    expect(readme).toContain('load_dataset("json", data_files=');
    expect(readme).toContain('dpo = load_dataset("json", data_files="dpo.jsonl", split="train")');
    expect(readme).toContain("- Training status: approved");
    expect(readme).toContain("- Mask personal data: yes");
    expect(readme).toContain(`| \`sft_train.jsonl\` | ${view.stats.sftTrain} |`);
    expect(readme).toContain("Nothing needed masking.");
  });

  it("lists redaction counts and skip reasons in the dataset card", async () => {
    chat(`token=abc123 and ${path.join(dir, "workspace", "a.ts")}`, "noted");
    const disliked = chat("q", "a");
    rate(disliked.id, disliked.replyId, "down");
    const view = await createDatasetExport(request());
    const readme = readText(view, "README.md");
    expect(readme).toContain("| path | `/workspace/...` | 1 |");
    expect(readme).toContain("| secret | `[REDACTED_SECRET]` | 1 |");
    expect(readme).toContain("| A thumbs-down without a correction (`negative_feedback`) | 1 |");
    expect(readme).not.toContain("config_name: dpo");
    expect(readme).not.toContain("split: test");
  });

  it("serves only recorded file names", async () => {
    chat("hi", "hello");
    const view = await createDatasetExport(request());
    expect(exportFile(view.id, "sft_train.jsonl")).toEqual({
      path: path.join(folder(view), "sft_train.jsonl"),
      name: "sft_train.jsonl",
      contentType: "application/x-ndjson; charset=utf-8",
    });
    expect(exportFile(view.id, "manifest.json")?.contentType).toBe("application/json; charset=utf-8");
    expect(exportFile(view.id, "README.md")?.contentType).toBe("text/markdown; charset=utf-8");
    for (const name of ["dpo.jsonl", "../tatvam.db", "..\\tatvam.db", "tatvam.db", "", "sft_train.jsonl/"])
      expect(exportFile(view.id, name), name).toBeNull();
    expect(exportFile("not-a-uuid", "sft_train.jsonl")).toBeNull();
    expect(exportFile(crypto.randomUUID(), "sft_train.jsonl")).toBeNull();
  });

  it("deletes the folder and the row", async () => {
    chat("hi", "hello");
    const view = await createDatasetExport(request());
    expect(existsSync(folder(view))).toBe(true);
    expect(await deleteDatasetExport(view.id)).toBe(true);
    expect(existsSync(folder(view))).toBe(false);
    expect(getDatasetExport(view.id)).toBeNull();
    expect(await deleteDatasetExport(view.id)).toBe(false);
    expect(await deleteDatasetExport("../../etc")).toBe(false);
  });
});

describe("limits", () => {
  it("refuses more conversations than the limit and leaves nothing behind", async () => {
    for (let index = 0; index < 3; index++) chat(`q${index}`, "a");
    const attempt = createDatasetExport(request(), { conversations: 2, bytes: 1_000_000 });
    await expect(attempt).rejects.toThrow(DatasetExportError);
    await expect(attempt).rejects.toMatchObject({ status: 422, message: expect.stringMatching(/match 3 conversations.*at most 2/) });
    expect(listDatasetExports()).toEqual([]);
    expect(existsSync(path.join(dir, "training", "exports")) ? readdirSync(path.join(dir, "training", "exports")) : []).toEqual([]);
  });

  it("refuses an export over the size cap and removes the partial files", async () => {
    for (let index = 0; index < 5; index++) chat(`question ${index} ${"x".repeat(200)}`, "answer");
    const attempt = createDatasetExport(request(), { conversations: 100, bytes: 600 });
    await expect(attempt).rejects.toMatchObject({ status: 422, message: expect.stringMatching(/larger than 600 B/) });
    expect(listDatasetExports()).toEqual([]);
    expect(readdirSync(path.join(dir, "training", "exports"))).toEqual([]);
  });
});
