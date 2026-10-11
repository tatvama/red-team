import "server-only";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  ConversationKind,
  ConversationSummary,
  FeedbackView,
  Isolation,
  TrainingStatus,
  Memory,
  PermissionMode,
  PlanItem,
  Provider,
  SubagentView,
  ToolPolicy,
} from "@/lib/contract";
import { dataDir } from "./config";

// Single-user local store on Node's built-in SQLite. Everything stays in DATA_DIR on this machine.

export type StoredToolCall = { id: string; name: string; arguments: string };
export type ToolResultStatus = "ok" | "error" | "denied";

export type StoredMessage =
  | { id: string; seq: number; role: "user"; content: string; createdAt: string }
  | {
      id: string;
      seq: number;
      role: "assistant";
      content: string;
      reasoning: string;
      toolCalls: StoredToolCall[];
      model: string | null;
      interrupted: boolean;
      createdAt: string;
    }
  | {
      id: string;
      seq: number;
      role: "tool";
      toolCallId: string;
      content: string;
      status: ToolResultStatus;
      createdAt: string;
    };

export type NewMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; reasoning: string; toolCalls: StoredToolCall[]; model: string; interrupted: boolean }
  | { role: "tool"; toolCallId: string; content: string; status: ToolResultStatus };

export type ConversationRow = ConversationSummary & {
  provider: Provider | null;
  model: string | null;
  permissionMode: PermissionMode;
  allowedTools: string[];
  plan: PlanItem[];
  workspaceMode: Isolation;
  /** Set for worktree tasks; shared tasks use WORKSPACE_DIR. */
  workspacePath: string | null;
  branch: string | null;
  baseBranch: string | null;
  baseCommit: string | null;
  kind: ConversationKind;
  trainingStatus: TrainingStatus;
};

export type CheckpointRecord = {
  id: string;
  conversationId: string;
  kind: "turn" | "tool";
  label: string;
  messageId: string | null;
  toolCallId: string | null;
  /** For turn checkpoints: the seq of the user message, so a rewind can delete from there. */
  messageSeq: number | null;
  commitSha: string;
  createdAt: string;
};

export type StoredSettings = { instructions: string; toolPolicies: Record<string, ToolPolicy> };

const MIGRATIONS = [
  `CREATE TABLE conversations (
     id TEXT PRIMARY KEY,
     title TEXT NOT NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     provider TEXT,
     model TEXT,
     permission_mode TEXT NOT NULL DEFAULT 'ask',
     allowed_tools TEXT NOT NULL DEFAULT '[]',
     plan TEXT NOT NULL DEFAULT '[]'
   );
   CREATE TABLE messages (
     id TEXT PRIMARY KEY,
     conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
     seq INTEGER NOT NULL,
     role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
     content TEXT NOT NULL DEFAULT '',
     reasoning TEXT NOT NULL DEFAULT '',
     tool_calls TEXT NOT NULL DEFAULT '[]',
     tool_call_id TEXT,
     tool_status TEXT CHECK (tool_status IN ('ok', 'error', 'denied')),
     model TEXT,
     interrupted INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL,
     UNIQUE (conversation_id, seq)
   );
   CREATE TABLE approvals (
     call_id TEXT PRIMARY KEY,
     conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
     decision TEXT NOT NULL CHECK (decision IN ('approve', 'deny')),
     created_at TEXT NOT NULL
   );
   CREATE TABLE memories (id TEXT PRIMARY KEY, text TEXT NOT NULL, created_at TEXT NOT NULL);
   CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
  `ALTER TABLE conversations ADD COLUMN workspace_mode TEXT NOT NULL DEFAULT 'shared';
   ALTER TABLE conversations ADD COLUMN workspace_path TEXT;
   ALTER TABLE conversations ADD COLUMN branch TEXT;
   ALTER TABLE conversations ADD COLUMN base_branch TEXT;
   ALTER TABLE conversations ADD COLUMN base_commit TEXT;
   CREATE TABLE checkpoints (
     id TEXT PRIMARY KEY,
     conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
     kind TEXT NOT NULL CHECK (kind IN ('turn', 'tool')),
     label TEXT NOT NULL,
     message_id TEXT,
     tool_call_id TEXT,
     message_seq INTEGER,
     commit_sha TEXT NOT NULL,
     created_at TEXT NOT NULL
   );
   CREATE INDEX checkpoints_conversation ON checkpoints(conversation_id, created_at);
   CREATE TABLE subagent_runs (
     id TEXT PRIMARY KEY,
     conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
     tool_call_id TEXT NOT NULL,
     role TEXT NOT NULL,
     task TEXT NOT NULL,
     status TEXT NOT NULL,
     steps INTEGER NOT NULL DEFAULT 0,
     activity TEXT NOT NULL DEFAULT '',
     report TEXT NOT NULL DEFAULT '',
     created_at TEXT NOT NULL
   );
   CREATE INDEX subagent_runs_conversation ON subagent_runs(conversation_id, created_at);`,
  `ALTER TABLE conversations ADD COLUMN kind TEXT NOT NULL DEFAULT 'chat';
   ALTER TABLE conversations ADD COLUMN training_status TEXT NOT NULL DEFAULT 'unreviewed';
   CREATE TABLE feedback (
     conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
     message_id TEXT NOT NULL,
     tool_call_id TEXT NOT NULL DEFAULT '',
     rating TEXT CHECK (rating IN ('up', 'down')),
     correction TEXT,
     note TEXT,
     updated_at TEXT NOT NULL,
     PRIMARY KEY (message_id, tool_call_id)
   );
   CREATE INDEX feedback_conversation ON feedback(conversation_id);
   CREATE TABLE dataset_exports (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, request TEXT NOT NULL, stats TEXT NOT NULL, files TEXT NOT NULL);
   CREATE TABLE eval_runs (
     id TEXT PRIMARY KEY, suite_id TEXT NOT NULL, target TEXT NOT NULL, judge TEXT, status TEXT NOT NULL, error TEXT,
     started_at TEXT NOT NULL, finished_at TEXT, summary TEXT NOT NULL, results TEXT NOT NULL
   );
   CREATE TABLE distill_jobs (
     id TEXT PRIMARY KEY, teacher TEXT NOT NULL, request TEXT NOT NULL, status TEXT NOT NULL, error TEXT,
     total INTEGER NOT NULL, completed INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0,
     conversation_ids TEXT NOT NULL DEFAULT '[]', started_at TEXT NOT NULL, finished_at TEXT
   );
   CREATE TABLE finetune_kits (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, request TEXT NOT NULL, path TEXT NOT NULL, files TEXT NOT NULL, instructions TEXT NOT NULL);
   CREATE TABLE registered_models (
     id TEXT PRIMARY KEY, provider TEXT NOT NULL, model_id TEXT NOT NULL, label TEXT NOT NULL, kind TEXT NOT NULL,
     parent_id TEXT, dataset_export_id TEXT, status TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL,
     UNIQUE (provider, model_id)
   );`,
];

type Row = Record<string, unknown>;
const globalStore = globalThis as unknown as { tatvamDb?: { file: string; db: DatabaseSync } };

function open(): DatabaseSync {
  const file = path.join(dataDir(), "tatvam.db");
  // Reuse one connection across hot reloads; reopen if DATA_DIR changed (tests).
  if (globalStore.tatvamDb?.file === file) return globalStore.tatvamDb.db;
  globalStore.tatvamDb?.db.close();
  mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  const version = Number((db.prepare("PRAGMA user_version").get() as Row).user_version);
  for (let index = version; index < MIGRATIONS.length; index++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[index]);
      db.exec(`PRAGMA user_version = ${index + 1}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  globalStore.tatvamDb = { file, db };
  return db;
}

/** The shared connection, for feature modules that keep their own tables (training, evals, models). */
export function database(): DatabaseSync {
  return open();
}

/** For tests: close the shared connection so a temp DATA_DIR can be removed. */
export function closeDb() {
  globalStore.tatvamDb?.db.close();
  globalStore.tatvamDb = undefined;
}

const now = () => new Date().toISOString();

function parseJson<T>(value: unknown, fallback: T): T {
  try {
    return typeof value === "string" ? (JSON.parse(value) as T) : fallback;
  } catch {
    return fallback;
  }
}

function toConversation(row: Row): ConversationRow {
  return {
    id: String(row.id),
    title: String(row.title),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    provider: (row.provider as Provider | null) ?? null,
    model: (row.model as string | null) ?? null,
    permissionMode: row.permission_mode as PermissionMode,
    allowedTools: parseJson<string[]>(row.allowed_tools, []),
    plan: parseJson<PlanItem[]>(row.plan, []),
    workspaceMode: row.workspace_mode === "worktree" ? "worktree" : "shared",
    workspacePath: (row.workspace_path as string | null) ?? null,
    branch: (row.branch as string | null) ?? null,
    baseBranch: (row.base_branch as string | null) ?? null,
    baseCommit: (row.base_commit as string | null) ?? null,
    kind: row.kind === "eval" || row.kind === "distill" ? row.kind : "chat",
    trainingStatus: row.training_status === "approved" || row.training_status === "excluded" ? row.training_status : "unreviewed",
  };
}

function toMessage(row: Row): StoredMessage {
  const base = { id: String(row.id), seq: Number(row.seq), content: String(row.content), createdAt: String(row.created_at) };
  if (row.role === "user") return { ...base, role: "user" };
  if (row.role === "tool")
    return { ...base, role: "tool", toolCallId: String(row.tool_call_id), status: row.tool_status as ToolResultStatus };
  return {
    ...base,
    role: "assistant",
    reasoning: String(row.reasoning),
    toolCalls: parseJson<StoredToolCall[]>(row.tool_calls, []),
    model: (row.model as string | null) ?? null,
    interrupted: Boolean(row.interrupted),
  };
}

/** Sidebar list: chat conversations only; eval and distillation runs live on the Training page. */
export function listConversations(): ConversationSummary[] {
  const rows = open()
    .prepare("SELECT id, title, created_at, updated_at FROM conversations WHERE kind = 'chat' ORDER BY updated_at DESC LIMIT 500")
    .all() as Row[];
  return rows.map((row) => ({
    id: String(row.id),
    title: String(row.title),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }));
}

export function createConversation(input: {
  title: string;
  provider: Provider;
  model: string;
  permissionMode: PermissionMode;
  kind?: ConversationKind;
  trainingStatus?: TrainingStatus;
}): ConversationRow {
  const id = crypto.randomUUID();
  const time = now();
  open()
    .prepare(
      `INSERT INTO conversations (id, title, created_at, updated_at, provider, model, permission_mode, kind, training_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.title,
      time,
      time,
      input.provider,
      input.model,
      input.permissionMode,
      input.kind ?? "chat",
      input.trainingStatus ?? "unreviewed",
    );
  return getConversation(id)!;
}

export function setTrainingStatus(id: string, status: TrainingStatus): boolean {
  return Number(open().prepare("UPDATE conversations SET training_status = ? WHERE id = ?").run(status, id).changes) > 0;
}

export function listFeedback(conversationId: string): FeedbackView[] {
  const rows = open()
    .prepare("SELECT * FROM feedback WHERE conversation_id = ? ORDER BY updated_at")
    .all(conversationId) as Row[];
  return rows.map((row) => ({
    messageId: String(row.message_id),
    toolCallId: row.tool_call_id ? String(row.tool_call_id) : null,
    rating: row.rating === "up" || row.rating === "down" ? row.rating : null,
    correction: (row.correction as string | null) ?? null,
    note: (row.note as string | null) ?? null,
    updatedAt: String(row.updated_at),
  }));
}

/** Saves feedback; all-empty feedback deletes the record. */
export function saveFeedback(conversationId: string, input: Omit<FeedbackView, "updatedAt">) {
  const db = open();
  const toolCallId = input.toolCallId ?? "";
  const correction = input.correction?.trim() ? input.correction : null;
  const note = input.note?.trim() ? input.note : null;
  if (!input.rating && !correction && !note) {
    db.prepare("DELETE FROM feedback WHERE message_id = ? AND tool_call_id = ?").run(input.messageId, toolCallId);
    return;
  }
  db.prepare(
    `INSERT INTO feedback (conversation_id, message_id, tool_call_id, rating, correction, note, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (message_id, tool_call_id) DO UPDATE SET rating = excluded.rating, correction = excluded.correction,
       note = excluded.note, updated_at = excluded.updated_at`,
  ).run(conversationId, input.messageId, toolCallId, input.rating, correction, note, now());
}

export function getConversation(id: string): ConversationRow | null {
  const row = open().prepare("SELECT * FROM conversations WHERE id = ?").get(id) as Row | undefined;
  return row ? toConversation(row) : null;
}

export function renameConversation(id: string, title: string): ConversationRow | null {
  open().prepare("UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?").run(title, now(), id);
  return getConversation(id);
}

export function deleteConversation(id: string): boolean {
  return Number(open().prepare("DELETE FROM conversations WHERE id = ?").run(id).changes) > 0;
}

export function updateConversationRun(
  id: string,
  run: { provider: Provider; model: string; permissionMode: PermissionMode },
) {
  open()
    .prepare("UPDATE conversations SET provider = ?, model = ?, permission_mode = ?, updated_at = ? WHERE id = ?")
    .run(run.provider, run.model, run.permissionMode, now(), id);
}

export function setConversationWorkspace(
  id: string,
  workspace: { mode: Isolation; path: string | null; branch: string | null; baseBranch: string | null; baseCommit: string | null },
) {
  open()
    .prepare(
      "UPDATE conversations SET workspace_mode = ?, workspace_path = ?, branch = ?, base_branch = ?, base_commit = ? WHERE id = ?",
    )
    .run(workspace.mode, workspace.path, workspace.branch, workspace.baseBranch, workspace.baseCommit, id);
}

export function setPlan(id: string, plan: PlanItem[]) {
  open().prepare("UPDATE conversations SET plan = ? WHERE id = ?").run(JSON.stringify(plan), id);
}

export function allowTool(id: string, toolName: string) {
  const conversation = getConversation(id);
  if (!conversation || conversation.allowedTools.includes(toolName)) return;
  open()
    .prepare("UPDATE conversations SET allowed_tools = ? WHERE id = ?")
    .run(JSON.stringify([...conversation.allowedTools, toolName]), id);
}

export function listMessages(conversationId: string): StoredMessage[] {
  const rows = open()
    .prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq")
    .all(conversationId) as Row[];
  return rows.map(toMessage);
}

export function appendMessage(conversationId: string, message: NewMessage): StoredMessage {
  const db = open();
  const id = crypto.randomUUID();
  const time = now();
  const next = Number(
    (db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM messages WHERE conversation_id = ?").get(conversationId) as Row)
      .next,
  );
  db.prepare(
    `INSERT INTO messages (id, conversation_id, seq, role, content, reasoning, tool_calls, tool_call_id, tool_status, model, interrupted, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    conversationId,
    next,
    message.role,
    message.content,
    message.role === "assistant" ? message.reasoning : "",
    message.role === "assistant" ? JSON.stringify(message.toolCalls) : "[]",
    message.role === "tool" ? message.toolCallId : null,
    message.role === "tool" ? message.status : null,
    message.role === "assistant" ? message.model : null,
    message.role === "assistant" && message.interrupted ? 1 : 0,
    time,
  );
  db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(time, conversationId);
  return toMessage(db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as Row);
}

export function updateAssistantMessage(
  id: string,
  fields: { content: string; reasoning: string; toolCalls: StoredToolCall[]; interrupted: boolean; model?: string },
) {
  open()
    .prepare(
      `UPDATE messages SET content = ?, reasoning = ?, tool_calls = ?, interrupted = ?, model = COALESCE(?, model)
       WHERE id = ? AND role = 'assistant'`,
    )
    .run(fields.content, fields.reasoning, JSON.stringify(fields.toolCalls), fields.interrupted ? 1 : 0, fields.model ?? null, id);
}

export function deleteMessage(id: string) {
  open().prepare("DELETE FROM messages WHERE id = ?").run(id);
}

/** Rewind: delete this message and everything after it, with any feedback given on those replies. */
export function deleteMessagesFrom(conversationId: string, seq: number) {
  const db = open();
  db.prepare(
    "DELETE FROM feedback WHERE conversation_id = ? AND message_id IN (SELECT id FROM messages WHERE conversation_id = ? AND seq >= ?)",
  ).run(conversationId, conversationId, seq);
  db.prepare("DELETE FROM messages WHERE conversation_id = ? AND seq >= ?").run(conversationId, seq);
}

function toCheckpoint(row: Row): CheckpointRecord {
  return {
    id: String(row.id),
    conversationId: String(row.conversation_id),
    kind: row.kind === "turn" ? "turn" : "tool",
    label: String(row.label),
    messageId: (row.message_id as string | null) ?? null,
    toolCallId: (row.tool_call_id as string | null) ?? null,
    messageSeq: row.message_seq === null || row.message_seq === undefined ? null : Number(row.message_seq),
    commitSha: String(row.commit_sha),
    createdAt: String(row.created_at),
  };
}

export function addCheckpointRecord(input: Omit<CheckpointRecord, "id" | "createdAt">): CheckpointRecord {
  const record: CheckpointRecord = { ...input, id: crypto.randomUUID(), createdAt: now() };
  open()
    .prepare(
      `INSERT INTO checkpoints (id, conversation_id, kind, label, message_id, tool_call_id, message_seq, commit_sha, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      record.id,
      record.conversationId,
      record.kind,
      record.label,
      record.messageId,
      record.toolCallId,
      record.messageSeq,
      record.commitSha,
      record.createdAt,
    );
  return record;
}

export function listCheckpointRecords(conversationId: string): CheckpointRecord[] {
  const rows = open()
    .prepare("SELECT * FROM checkpoints WHERE conversation_id = ? ORDER BY created_at, rowid")
    .all(conversationId) as Row[];
  return rows.map(toCheckpoint);
}

export function getCheckpointRecord(conversationId: string, id: string): CheckpointRecord | null {
  const row = open().prepare("SELECT * FROM checkpoints WHERE conversation_id = ? AND id = ?").get(conversationId, id) as
    | Row
    | undefined;
  return row ? toCheckpoint(row) : null;
}

/** After a conversation rewind, checkpoints taken later point at deleted messages. */
export function deleteCheckpointsAfter(conversationId: string, checkpoint: CheckpointRecord) {
  open()
    .prepare("DELETE FROM checkpoints WHERE conversation_id = ? AND rowid > (SELECT rowid FROM checkpoints WHERE id = ?)")
    .run(conversationId, checkpoint.id);
}

export function upsertSubagentRun(conversationId: string, run: SubagentView) {
  open()
    .prepare(
      `INSERT INTO subagent_runs (id, conversation_id, tool_call_id, role, task, status, steps, activity, report, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET status = excluded.status, steps = excluded.steps,
         activity = excluded.activity, report = excluded.report`,
    )
    .run(run.id, conversationId, run.toolCallId, run.role, run.task, run.status, run.steps, run.activity, run.report, run.createdAt);
}

export function listSubagentRuns(conversationId: string): SubagentView[] {
  const rows = open()
    .prepare("SELECT * FROM subagent_runs WHERE conversation_id = ? ORDER BY created_at, rowid")
    .all(conversationId) as Row[];
  return rows.map((row) => ({
    id: String(row.id),
    toolCallId: String(row.tool_call_id),
    role: row.role as SubagentView["role"],
    task: String(row.task),
    status: row.status as SubagentView["status"],
    steps: Number(row.steps),
    activity: String(row.activity),
    report: String(row.report),
    createdAt: String(row.created_at),
  }));
}

/** Generic JSON settings for features that keep small state (for example disabled MCP servers). */
export function getSetting<T>(key: string, fallback: T): T {
  const row = open().prepare("SELECT value FROM settings WHERE key = ?").get(key) as Row | undefined;
  return row ? parseJson<T>(row.value, fallback) : fallback;
}

export function setSetting(key: string, value: unknown) {
  open()
    .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
    .run(key, JSON.stringify(value));
}

export function recordApproval(conversationId: string, callId: string, decision: "approve" | "deny") {
  open()
    .prepare(
      `INSERT INTO approvals (call_id, conversation_id, decision, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (call_id) DO UPDATE SET decision = excluded.decision`,
    )
    .run(callId, conversationId, decision, now());
}

export function getApproval(conversationId: string, callId: string): "approve" | "deny" | null {
  const row = open()
    .prepare("SELECT decision FROM approvals WHERE conversation_id = ? AND call_id = ?")
    .get(conversationId, callId) as Row | undefined;
  return row ? (row.decision as "approve" | "deny") : null;
}

export function listMemories(): Memory[] {
  const rows = open().prepare("SELECT * FROM memories ORDER BY created_at").all() as Row[];
  return rows.map((row) => ({ id: String(row.id), text: String(row.text), createdAt: String(row.created_at) }));
}

export function addMemory(text: string): Memory {
  const memory = { id: crypto.randomUUID(), text, createdAt: now() };
  open().prepare("INSERT INTO memories (id, text, created_at) VALUES (?, ?, ?)").run(memory.id, text, memory.createdAt);
  return memory;
}

export function deleteMemory(id: string): boolean {
  return Number(open().prepare("DELETE FROM memories WHERE id = ?").run(id).changes) > 0;
}

export function getSettings(): StoredSettings {
  const rows = open().prepare("SELECT key, value FROM settings").all() as Row[];
  const values = Object.fromEntries(rows.map((row) => [String(row.key), parseJson<unknown>(row.value, null)]));
  return {
    instructions: typeof values.instructions === "string" ? values.instructions : "",
    toolPolicies:
      values.toolPolicies && typeof values.toolPolicies === "object"
        ? (values.toolPolicies as Record<string, ToolPolicy>)
        : {},
  };
}

export function saveSettings(settings: StoredSettings) {
  const db = open();
  const upsert = db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
  );
  db.exec("BEGIN");
  try {
    upsert.run("instructions", JSON.stringify(settings.instructions));
    upsert.run("toolPolicies", JSON.stringify(settings.toolPolicies));
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
