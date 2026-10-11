import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import type { DatasetExportRequest, DatasetExportView, FeedbackView } from "@/lib/contract";
import { systemPrompt } from "../agent";
import { dataDir } from "../config";
import * as db from "../db";
import { wireTools } from "../history";
import type { WireMessage, WireTool } from "../llm";
import { builtinTools } from "../tools";
import {
  addCounts,
  defaultRedactionRoots,
  REDACTION_PLACEHOLDERS,
  redact,
  redactArguments,
  type RedactionCounts,
  type RedactOptions,
} from "./redact";

// Turns reviewed conversations into a fine-tuning dataset on disk: SFT examples in OpenAI chat
// format, DPO preference pairs from corrections, a manifest and a dataset card. Files are written to
// DATA_DIR/training/exports/<id>/ and the export is recorded in the dataset_exports table.

export const EXPORT_FILES = {
  sftTrain: "sft_train.jsonl",
  sftEval: "sft_eval.jsonl",
  dpo: "dpo.jsonl",
  manifest: "manifest.json",
  readme: "README.md",
} as const;

export type ExportLimits = { conversations: number; bytes: number };
export const EXPORT_LIMITS: ExportLimits = { conversations: 5_000, bytes: 200 * 1024 * 1024 };

export const MINIMAL_SYSTEM_PROMPT = "You are Tatvam, a helpful AI assistant.";

export const SKIP_REASONS = {
  no_assistant_reply: "No assistant reply",
  interrupted: "The last reply was interrupted",
  invalid_tool_calls: "A tool call named an unknown tool or sent invalid arguments",
  negative_feedback: "A thumbs-down without a correction",
  no_positive_feedback: "No thumbs-up (positive feedback was required)",
} as const;
export type SkipReason = keyof typeof SKIP_REASONS;

export class DatasetExportError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export type SftExample = { messages: WireMessage[]; tools: WireTool[] };
export type PreferencePair = { prompt: WireMessage[]; chosen: WireMessage[]; rejected: WireMessage[] };
export type ConversationExamples =
  | { skipped: SkipReason }
  | { skipped: null; example: SftExample; pairs: PreferencePair[]; redactions: RedactionCounts };
export type BuildOptions = {
  system: string;
  requirePositiveFeedback: boolean;
  redactPii: boolean;
  /** Folders rewritten to `/workspace`; defaults to the workspace and data folders. */
  roots?: readonly string[];
};

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INVALID_RESULT = /^(?:Unknown tool|The arguments were not valid JSON|Invalid arguments)/;
const MISSING_RESULT = "No result (interrupted).";

export function exportsRoot(): string {
  return path.join(dataDir(), "training", "exports");
}

export function exportDir(id: string): string {
  if (!ID_PATTERN.test(id)) throw new Error("Invalid export id");
  return path.join(exportsRoot(), id);
}

/**
 * A stable system prompt for training. `agent` is Tatvam's tool-using guidance without the date,
 * permission mode, memories or custom instructions, so every example shares the same prompt.
 */
export function trainingSystemPrompt(kind: DatasetExportRequest["systemPrompt"]): string {
  if (kind === "minimal") return MINIMAL_SYSTEM_PROMPT;
  const prompt = systemPrompt({
    mode: "ask",
    toolNames: builtinTools.map((tool) => tool.name),
    instructions: "",
    memories: [],
    trimmed: false,
  });
  return prompt
    .split("\n\n")
    .filter((part) => !/^(?:Current date|Permission mode):/.test(part))
    .join("\n\n");
}

// ── Building examples ────────────────────────────────────────────────────────

type AssistantMessage = Extract<db.StoredMessage, { role: "assistant" }>;
type ToolMessage = Extract<db.StoredMessage, { role: "tool" }>;

/** Messages are kept raw until an example is written, so only text that is exported gets redacted and counted. */
type Entry =
  | { role: "user"; key: string; content: string }
  | { role: "assistant"; key: string; content: string; calls: db.StoredToolCall[] }
  | { role: "tool"; key: string; toolCallId: string; content: string };

/** Redacts each source text once per conversation, so a message shared by SFT and DPO is counted once. */
class Redactor {
  readonly counts: RedactionCounts = {};
  private readonly memo = new Map<string, string>();

  constructor(private readonly options: RedactOptions) {}

  private once(key: string, value: string, run: (value: string, options: RedactOptions) => { text: string; counts: RedactionCounts }) {
    const cached = this.memo.get(key);
    if (cached !== undefined) return cached;
    const result = run(value, this.options);
    addCounts(this.counts, result.counts);
    this.memo.set(key, result.text);
    return result.text;
  }

  text(key: string, value: string): string {
    return this.once(`text:${key}`, value, redact);
  }

  args(key: string, value: string): string {
    return this.once(`args:${key}`, value, redactArguments);
  }
}

function materialize(entries: Entry[], redactor: Redactor): WireMessage[] {
  return entries.map((entry): WireMessage => {
    if (entry.role === "user") return { role: "user", content: redactor.text(entry.key, entry.content) };
    if (entry.role === "tool")
      return { role: "tool", tool_call_id: entry.toolCallId, content: redactor.text(entry.key, entry.content) };
    const content = redactor.text(entry.key, entry.content);
    if (!entry.calls.length) return { role: "assistant", content };
    return {
      role: "assistant",
      content,
      tool_calls: entry.calls.map((call) => ({
        id: call.id,
        type: "function" as const,
        function: { name: call.name, arguments: redactor.args(`${entry.key}:${call.id}`, call.arguments) },
      })),
    };
  });
}

function normalize(text: string): string {
  return text.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

let builtinNames: Set<string> | undefined;

/**
 * One conversation as one SFT example plus a preference pair per corrected text reply, or the
 * reason it was skipped. Feedback whose message no longer exists (after a rewind) is ignored.
 */
export function buildConversationExamples(
  messages: db.StoredMessage[],
  feedback: FeedbackView[],
  options: BuildOptions,
): ConversationExamples {
  builtinNames ??= new Set(builtinTools.map((tool) => tool.name));
  const assistantIds = new Set(messages.flatMap((message) => (message.role === "assistant" ? [message.id] : [])));
  const live = feedback.filter((item) => assistantIds.has(item.messageId));
  const corrections = new Map<string, string>();
  for (const item of live)
    if (item.toolCallId === null && item.correction?.trim()) corrections.set(item.messageId, item.correction.trim());
  const results = new Map<string, ToolMessage>();
  for (const message of messages) if (message.role === "tool" && !results.has(message.toolCallId)) results.set(message.toolCallId, message);

  // `history` follows the conversation as it happened (for DPO prompts); `sft` freezes at the first correction.
  const history: Entry[] = [];
  let sft: Entry[] | null = null;
  const pairs: { prompt: Entry[]; chosen: Entry; rejected: Entry }[] = [];
  const used = new Set<string>();
  let lastReply: AssistantMessage | null = null;
  let invalid = false;

  for (const message of messages) {
    if (message.role === "tool") continue;
    if (message.role === "user") {
      history.push({ role: "user", key: message.id, content: message.content });
      continue;
    }
    const inSft = sft === null;
    const correction = corrections.get(message.id);
    const empty = !message.content.trim() && !message.toolCalls.length;
    if (correction !== undefined) {
      const chosen: Entry = { role: "assistant", key: `${message.id}:correction`, content: correction, calls: [] };
      // Interrupted originals are incomplete rather than wrong, so they make poor "rejected" examples.
      if (!message.interrupted && !message.toolCalls.length && message.content.trim() && normalize(message.content) !== normalize(correction))
        pairs.push({
          prompt: [...history],
          chosen,
          rejected: { role: "assistant", key: message.id, content: message.content, calls: [] },
        });
      if (inSft) sft = [...history, chosen];
    } else if (inSft && (message.interrupted || !empty)) lastReply = message;
    // Dropped replies take their tool results with them, so every kept call keeps its result.
    if (message.interrupted || empty) continue;
    history.push({ role: "assistant", key: message.id, content: message.content, calls: message.toolCalls });
    for (const call of message.toolCalls) {
      const result = results.get(call.id);
      history.push({
        role: "tool",
        key: result ? result.id : `${call.id}:missing`,
        toolCallId: call.id,
        content: result ? result.content : MISSING_RESULT,
      });
      if (inSft && correction === undefined) {
        if (builtinNames.has(call.name)) used.add(call.name);
        if (result && INVALID_RESULT.test(result.content)) invalid = true;
      }
    }
  }

  if (sft === null) {
    if (!lastReply) return { skipped: "no_assistant_reply" };
    if (lastReply.interrupted) return { skipped: "interrupted" };
  }
  if (invalid) return { skipped: "invalid_tool_calls" };
  if (live.some((item) => item.rating === "down" && !corrections.has(item.messageId))) return { skipped: "negative_feedback" };
  if (options.requirePositiveFeedback && !live.some((item) => item.rating === "up")) return { skipped: "no_positive_feedback" };

  const entries = sft ?? history;
  // A trailing user message has no reply to learn from.
  while (entries.length && entries[entries.length - 1].role === "user") entries.pop();

  const redactor = new Redactor({ pii: options.redactPii, roots: options.roots });
  const system: WireMessage = { role: "system", content: options.system };
  const example: SftExample = {
    messages: [system, ...materialize(entries, redactor)],
    tools: wireTools(builtinTools.filter((tool) => used.has(tool.name))),
  };
  const preference = pairs.map((pair) => ({
    prompt: [system, ...materialize(pair.prompt, redactor)],
    chosen: materialize([pair.chosen], redactor),
    rejected: materialize([pair.rejected], redactor),
  }));
  return { skipped: null, example, pairs: preference, redactions: redactor.counts };
}

/** sha256 over the normalized user and assistant text (tool calls included), used for deduplication and the split. */
export function exampleHash(messages: WireMessage[]): string {
  const hash = createHash("sha256");
  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    hash.update(`${message.role}\u0000${normalize(message.content)}\u0000`);
    if (message.role === "assistant")
      for (const call of message.tool_calls ?? [])
        hash.update(`call\u0000${call.function.name}\u0000${normalize(call.function.arguments)}\u0000`);
  }
  return hash.digest("hex");
}

function pairHash(pair: PreferencePair): string {
  return createHash("sha256")
    .update(`${exampleHash(pair.prompt)}:${exampleHash(pair.chosen)}:${exampleHash(pair.rejected)}`)
    .digest("hex");
}

/** A number in [0, 1) taken from the hash, so the same example always lands in the same split. */
export function splitBucket(hash: string): number {
  return Number.parseInt(hash.slice(0, 13), 16) / 2 ** 52;
}

// ── Writing an export ────────────────────────────────────────────────────────

type Row = Record<string, unknown>;
type FileEntry = DatasetExportView["files"][number];

class JsonlFile {
  bytes = 0;
  records = 0;
  private fd: number | null = null;

  constructor(
    readonly name: string,
    private readonly file: string,
  ) {}

  open(): this {
    if (this.fd === null) this.fd = openSync(this.file, "w");
    return this;
  }

  write(record: unknown) {
    const buffer = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
    writeSync(this.open().fd!, buffer);
    this.bytes += buffer.length;
    this.records += 1;
  }

  close() {
    if (this.fd !== null) closeSync(this.fd);
    this.fd = null;
  }

  entry(): FileEntry {
    return { name: this.name, bytes: this.bytes, records: this.records };
  }
}

function writeText(file: string, text: string): number {
  const buffer = Buffer.from(text, "utf8");
  writeFileSync(file, buffer);
  return buffer.length;
}

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));
const count = (value: number) => value.toLocaleString("en-US");

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Builds and writes a dataset. Throws DatasetExportError (with an HTTP status) when the selection
 * or the output is over the limits; nothing is left on disk in that case.
 */
export async function createDatasetExport(
  request: DatasetExportRequest,
  limits: ExportLimits = EXPORT_LIMITS,
): Promise<DatasetExportView> {
  const statuses = [...new Set(request.statuses)];
  const kinds = [...new Set(request.kinds)];
  const connection = db.database();
  const rows = connection
    .prepare(
      `SELECT id, workspace_path FROM conversations
       WHERE training_status IN (${statuses.map(() => "?").join(", ")}) AND kind IN (${kinds.map(() => "?").join(", ")})
       ORDER BY created_at, id`,
    )
    .all(...statuses, ...kinds) as Row[];
  if (rows.length > limits.conversations)
    throw new DatasetExportError(
      `These filters match ${count(rows.length)} conversations, and an export can hold at most ${count(limits.conversations)}. ` +
        "Choose fewer statuses or kinds, or exclude some conversations first.",
      422,
    );

  const id = randomUUID();
  const createdAt = new Date().toISOString();
  const dir = exportDir(id);
  mkdirSync(dir, { recursive: true });
  const train = new JsonlFile(EXPORT_FILES.sftTrain, path.join(dir, EXPORT_FILES.sftTrain));
  const evaluation = new JsonlFile(EXPORT_FILES.sftEval, path.join(dir, EXPORT_FILES.sftEval));
  const dpo = new JsonlFile(EXPORT_FILES.dpo, path.join(dir, EXPORT_FILES.dpo));
  const tooLarge = () =>
    new DatasetExportError(
      `This export would be larger than ${formatBytes(limits.bytes)}. Choose fewer statuses or kinds, or exclude some conversations first.`,
      422,
    );

  try {
    train.open();
    evaluation.open();
    const stats: DatasetExportView["stats"] = {
      conversations: 0,
      sftTrain: 0,
      sftEval: 0,
      preferencePairs: 0,
      duplicatesDropped: 0,
      redactions: {},
      skipped: {},
    };
    const system = trainingSystemPrompt(request.systemPrompt);
    const baseRoots = defaultRedactionRoots();
    const seen = new Set<string>();

    for (let index = 0; index < rows.length; index++) {
      // Building is synchronous; yield now and then so other requests are not starved.
      if (index > 0 && index % 25 === 0) await yieldToEventLoop();
      const conversationId = String(rows[index].id);
      const worktree = rows[index].workspace_path;
      const built = buildConversationExamples(db.listMessages(conversationId), db.listFeedback(conversationId), {
        system,
        requirePositiveFeedback: request.requirePositiveFeedback,
        redactPii: request.redactPii,
        roots: typeof worktree === "string" && worktree ? [worktree, ...baseRoots] : baseRoots,
      });
      if (built.skipped) {
        stats.skipped[built.skipped] = (stats.skipped[built.skipped] ?? 0) + 1;
        continue;
      }
      stats.conversations += 1;
      let wrote = false;
      const hash = exampleHash(built.example.messages);
      if (seen.has(hash)) stats.duplicatesDropped += 1;
      else {
        seen.add(hash);
        (splitBucket(hash) < request.evalFraction ? evaluation : train).write(built.example);
        wrote = true;
      }
      for (const pair of built.pairs) {
        const key = `dpo:${pairHash(pair)}`;
        if (seen.has(key)) {
          stats.duplicatesDropped += 1;
          continue;
        }
        seen.add(key);
        dpo.write(pair);
        wrote = true;
      }
      if (wrote) addCounts(stats.redactions, built.redactions);
      if (train.bytes + evaluation.bytes + dpo.bytes > limits.bytes) throw tooLarge();
    }
    train.close();
    evaluation.close();
    dpo.close();
    stats.sftTrain = train.records;
    stats.sftEval = evaluation.records;
    stats.preferencePairs = dpo.records;

    const dataFiles = [train.entry(), evaluation.entry(), ...(dpo.records ? [dpo.entry()] : [])];
    const card = { id, createdAt, request, stats, files: dataFiles, system, selected: rows.length };
    const readme: FileEntry = {
      name: EXPORT_FILES.readme,
      bytes: writeText(path.join(dir, EXPORT_FILES.readme), datasetCard(card)),
      records: 0,
    };
    const listed = [...dataFiles, readme];
    const manifest: FileEntry = {
      name: EXPORT_FILES.manifest,
      bytes: writeText(path.join(dir, EXPORT_FILES.manifest), `${JSON.stringify(manifestFor({ ...card, files: listed }), null, 2)}\n`),
      records: 0,
    };
    const files = [...listed, manifest];
    if (files.reduce((sum, file) => sum + file.bytes, 0) > limits.bytes) throw tooLarge();

    connection
      .prepare("INSERT INTO dataset_exports (id, created_at, request, stats, files) VALUES (?, ?, ?, ?, ?)")
      .run(id, createdAt, JSON.stringify(request), JSON.stringify(stats), JSON.stringify(files));
    return { id, createdAt, request, stats, files };
  } catch (error) {
    train.close();
    evaluation.close();
    dpo.close();
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

// ── Manifest and dataset card ────────────────────────────────────────────────

type CardInput = {
  id: string;
  createdAt: string;
  request: DatasetExportRequest;
  stats: DatasetExportView["stats"];
  files: FileEntry[];
  system: string;
  selected: number;
};

const FORMAT_NOTES: Record<string, string> = {
  [EXPORT_FILES.sftTrain]:
    "SFT examples for training. One JSON object per line in OpenAI chat format: `messages` (system, user, assistant with optional " +
    "`tool_calls`, tool) and `tools` (function schemas of the built-in tools the conversation used).",
  [EXPORT_FILES.sftEval]: "Held-out SFT examples, same format as sft_train.jsonl, chosen deterministically by content hash.",
  [EXPORT_FILES.dpo]:
    "Preference pairs from corrected replies. One JSON object per line: `prompt` (system plus the conversation before the reply), " +
    "`chosen` (the correction) and `rejected` (the original reply), each a list of chat messages.",
  [EXPORT_FILES.readme]: "Dataset card: contents, formats, filters, redaction counts and how to load the files.",
};

function manifestFor(input: CardInput) {
  return {
    format: "tatvam-dataset",
    formatVersion: 1,
    id: input.id,
    createdAt: input.createdAt,
    request: input.request,
    selectedConversations: input.selected,
    stats: input.stats,
    files: input.files.map((file) => ({ ...file, description: FORMAT_NOTES[file.name] ?? "" })),
    systemPrompt: input.system,
    notes: {
      sft:
        "Reasoning is dropped, and interrupted or empty replies are dropped with their tool results. A reply with a correction is " +
        "replaced by the correction (without tool calls) and the example ends there. Tool call arguments are JSON strings.",
      dpo: "Written only for corrected replies whose original had text and no tool calls.",
      deduplication: "sha256 over the normalized (NFKC, whitespace collapsed, lowercased) user and assistant text, including tool calls.",
      split: "The first 52 bits of the example hash divided by 2^52; values below evalFraction go to sft_eval.jsonl.",
      redaction: {
        secrets: "always masked",
        pii: input.request.redactPii ? "emails, phone numbers and IP addresses masked" : "not masked",
        paths: "absolute paths under the workspace and data folders are rewritten to /workspace",
        placeholders: REDACTION_PLACEHOLDERS,
      },
    },
  };
}

const yesNo = (value: boolean) => (value ? "yes" : "no");

function datasetCard(input: CardInput): string {
  const { request, stats } = input;
  const present = (name: string) => input.files.some((file) => file.name === name && file.records > 0);
  const sftSplits = [
    ...(present(EXPORT_FILES.sftTrain) ? [{ split: "train", path: EXPORT_FILES.sftTrain }] : []),
    ...(present(EXPORT_FILES.sftEval) ? [{ split: "test", path: EXPORT_FILES.sftEval }] : []),
  ];
  const configs = [
    ...(sftSplits.length
      ? ["- config_name: sft", "  data_files:", ...sftSplits.flatMap((item) => [`  - split: ${item.split}`, `    path: ${item.path}`])]
      : []),
    ...(present(EXPORT_FILES.dpo) ? ["- config_name: dpo", "  data_files:", "  - split: train", `    path: ${EXPORT_FILES.dpo}`] : []),
  ];
  const lines: string[] = [
    "---",
    `pretty_name: Tatvam Agent conversations ${input.createdAt.slice(0, 10)}`,
    "task_categories:",
    "- text-generation",
    "tags:",
    "- tool-use",
    "- agents",
    "- tatvam",
    ...(configs.length ? ["configs:", ...configs] : []),
    "---",
    "",
    "# Tatvam Agent training data",
    "",
    `Exported from Tatvam Agent on ${input.createdAt} (export \`${input.id}\`). Reviewed conversations are converted to ` +
      "supervised fine-tuning (SFT) examples in OpenAI chat format and, where a reply was corrected, preference pairs for DPO.",
    "",
    "## Contents",
    "",
    "| File | Records | Size | What it holds |",
    "| --- | ---: | ---: | --- |",
    ...input.files.map(
      (file) =>
        `| \`${file.name}\` | ${file.name.endsWith(".jsonl") ? count(file.records) : "-"} | ${formatBytes(file.bytes)} | ${FORMAT_NOTES[file.name] ?? ""} |`,
    ),
    `| \`${EXPORT_FILES.manifest}\` | - | - | Machine-readable request, statistics, file list and format notes. |`,
    "",
    `- Conversations matching the filters: ${count(input.selected)}`,
    `- Conversations used: ${count(stats.conversations)}`,
    `- SFT examples: ${count(stats.sftTrain)} train, ${count(stats.sftEval)} eval`,
    `- Preference pairs: ${count(stats.preferencePairs)}`,
    `- Duplicates dropped: ${count(stats.duplicatesDropped)}`,
    "",
  ];
  const skipped = Object.entries(stats.skipped);
  if (skipped.length)
    lines.push(
      "Conversations left out:",
      "",
      "| Reason | Conversations |",
      "| --- | ---: |",
      ...skipped.map(([reason, total]) => `| ${SKIP_REASONS[reason as SkipReason] ?? reason} (\`${reason}\`) | ${count(total)} |`),
      "",
    );
  lines.push(
    "## Formats",
    "",
    `### SFT (\`${EXPORT_FILES.sftTrain}\`, \`${EXPORT_FILES.sftEval}\`)`,
    "",
    "One JSON object per line:",
    "",
    "```json",
    JSON.stringify({
      messages: [
        { role: "system", content: "..." },
        { role: "user", content: "Fix the failing test" },
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"src/app.ts"}' } }],
        },
        { role: "tool", tool_call_id: "call_1", content: "..." },
        { role: "assistant", content: "The test failed because ..." },
      ],
      tools: [{ type: "function", function: { name: "read_file", description: "...", parameters: { type: "object" } } }],
    }),
    "```",
    "",
    request.systemPrompt === "agent"
      ? "- `system` is Tatvam's tool-using guidance, without the date, permission mode, memories or custom instructions, so every example shares it."
      : `- \`system\` is the one-line prompt "${MINIMAL_SYSTEM_PROMPT}".`,
    "- `tools` holds the JSON schemas of the built-in tools the conversation used. Calls to MCP tools stay in the messages without a schema.",
    "- `tool_calls[].function.arguments` is a JSON string, as in the OpenAI API. `content` is always a string.",
    "- Reasoning is dropped. Interrupted and empty replies are dropped together with their tool results.",
    "- Where a reply has a correction, the correction replaces it (without tool calls) and the example ends there.",
    `- The eval split holds about ${Math.round(request.evalFraction * 100)}% of the examples, chosen by content hash, so it is stable across exports.`,
    "",
    `### Preference pairs (\`${EXPORT_FILES.dpo}\`)`,
    "",
    "```json",
    JSON.stringify({
      prompt: [
        { role: "system", content: "..." },
        { role: "user", content: "..." },
      ],
      chosen: [{ role: "assistant", content: "The corrected reply" }],
      rejected: [{ role: "assistant", content: "The original reply" }],
    }),
    "```",
    "",
    "Written for each corrected reply whose original had text and no tool calls. This is the conversational format TRL's `DPOTrainer` accepts.",
    "",
    "## Filters",
    "",
    `- Training status: ${request.statuses.join(", ")}`,
    `- Conversation kinds: ${request.kinds.join(", ")}`,
    `- Require positive feedback: ${yesNo(request.requirePositiveFeedback)}`,
    `- Mask personal data: ${yesNo(request.redactPii)}`,
    `- Eval fraction: ${request.evalFraction}`,
    `- System prompt: ${request.systemPrompt}`,
    "",
    "A conversation is left out when it has no assistant reply, its last reply was interrupted, it has a tool call that named an " +
      "unknown tool or sent invalid arguments (and was not corrected), or it has a thumbs-down without a correction. With " +
      "positive feedback required, it also needs at least one thumbs-up. Exact duplicates are dropped.",
    "",
    "## Redaction",
    "",
    "Secrets are always masked: API keys and tokens (OpenAI, GitHub, AWS, Slack, Hugging Face, Google), private keys, JWTs, " +
      "`Authorization` header values, password, secret, token and API key assignments, and credentials in URLs. " +
      (request.redactPii ? "Emails, phone numbers and IP addresses are masked too. " : "Personal data (emails, phone numbers, IP addresses) was not masked. ") +
      "Absolute paths under the workspace and data folders are rewritten to `/workspace`.",
    "",
  );
  const redactions = Object.entries(stats.redactions).sort(([a], [b]) => a.localeCompare(b));
  if (redactions.length)
    lines.push(
      "| Kind | Replaced with | Count |",
      "| --- | --- | ---: |",
      ...redactions.map(
        ([kind, total]) =>
          `| ${kind} | \`${kind === "path" ? "/workspace/..." : (REDACTION_PLACEHOLDERS[kind as keyof typeof REDACTION_PLACEHOLDERS] ?? kind)}\` | ${count(total)} |`,
      ),
      "",
    );
  else lines.push("Nothing needed masking.", "");
  lines.push(
    "Redaction is pattern based and can miss values. Read the files before sharing them beyond this machine.",
    "",
    "## Loading",
    "",
    "```python",
    "from datasets import load_dataset",
    "",
  );
  if (sftSplits.length)
    lines.push(
      `sft = load_dataset("json", data_files={${sftSplits.map((item) => `"${item.split}": "${item.path}"`).join(", ")}})`,
    );
  if (present(EXPORT_FILES.dpo)) lines.push(`dpo = load_dataset("json", data_files="${EXPORT_FILES.dpo}", split="train")`);
  if (!sftSplits.length && !present(EXPORT_FILES.dpo)) lines.push("# This export has no examples.");
  lines.push(
    "```",
    "",
    "Each row's `tools` holds full JSON schemas, which differ between rows. If `load_dataset` cannot infer one schema for them, " +
      "read the files line by line with `json.loads`, or store `tools` as a JSON string with `json.dumps` before building a `Dataset`.",
    "",
  );
  return lines.join("\n");
}

// ── Reading and deleting exports ─────────────────────────────────────────────

function parse<T>(value: unknown, fallback: T): T {
  try {
    return typeof value === "string" ? (JSON.parse(value) as T) : fallback;
  } catch {
    return fallback;
  }
}

function toView(row: Row): DatasetExportView {
  const stats = parse<Partial<DatasetExportView["stats"]>>(row.stats, {});
  return {
    id: String(row.id),
    createdAt: String(row.created_at),
    request: parse<DatasetExportRequest>(row.request, {
      statuses: ["approved"],
      kinds: ["chat"],
      requirePositiveFeedback: false,
      redactPii: false,
      evalFraction: 0,
      systemPrompt: "agent",
    }),
    stats: {
      conversations: stats.conversations ?? 0,
      sftTrain: stats.sftTrain ?? 0,
      sftEval: stats.sftEval ?? 0,
      preferencePairs: stats.preferencePairs ?? 0,
      duplicatesDropped: stats.duplicatesDropped ?? 0,
      redactions: stats.redactions ?? {},
      skipped: stats.skipped ?? {},
    },
    files: parse<FileEntry[]>(row.files, []),
  };
}

/** Newest first. */
export function listDatasetExports(): DatasetExportView[] {
  const rows = db.database().prepare("SELECT * FROM dataset_exports ORDER BY created_at DESC, rowid DESC").all() as Row[];
  return rows.map(toView);
}

export function getDatasetExport(id: string): DatasetExportView | null {
  if (!ID_PATTERN.test(id)) return null;
  const row = db.database().prepare("SELECT * FROM dataset_exports WHERE id = ?").get(id) as Row | undefined;
  return row ? toView(row) : null;
}

/** Removes the export's folder and its row. False when there is no such export. */
export async function deleteDatasetExport(id: string): Promise<boolean> {
  if (!getDatasetExport(id)) return false;
  await rm(exportDir(id), { recursive: true, force: true, maxRetries: 3 });
  db.database().prepare("DELETE FROM dataset_exports WHERE id = ?").run(id);
  return true;
}

const CONTENT_TYPES: Record<string, string> = {
  ".jsonl": "application/x-ndjson; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

export type ExportFile = { path: string; name: string; contentType: string };

/**
 * The file to serve for a download, or null. Only names recorded for this export are served, so a
 * name such as `../tatvam.db` never reaches the filesystem.
 */
export function exportFile(id: string, name: string): ExportFile | null {
  const entry = getDatasetExport(id)?.files.find((file) => file.name === name);
  if (!entry || !/^[\w.-]+$/.test(entry.name) || path.basename(entry.name) !== entry.name || entry.name.startsWith(".")) return null;
  return {
    path: path.join(exportDir(id), entry.name),
    name: entry.name,
    contentType: CONTENT_TYPES[path.extname(entry.name)] ?? "application/octet-stream",
  };
}
