import "server-only";
import type { ConversationKind, TrainingConversationView, TrainingStatus } from "@/lib/contract";
import { database } from "../db";

// The review queue: every conversation (chat, eval and distill) with the numbers a reviewer needs
// to decide whether it belongs in a training dataset. All counts are computed in SQL.

export type ReviewFilters = { status?: TrainingStatus; kind?: ConversationKind };
export const REVIEW_QUEUE_LIMIT = 500;

type Row = Record<string, unknown>;

// Feedback rows survive a rewind that deletes their message, so they only count while the message exists.
const LIVE_FEEDBACK = "FROM feedback f JOIN messages fm ON fm.id = f.message_id WHERE f.conversation_id = c.id";

const QUERY = `
  SELECT c.id, c.title, c.created_at, c.updated_at, c.kind, c.training_status, c.model,
    (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND (m.role = 'user' OR
       (m.role = 'assistant' AND (m.content <> '' OR m.reasoning <> '' OR m.tool_calls NOT IN ('', '[]'))))) AS message_count,
    (SELECT COALESCE(SUM(json_array_length(m.tool_calls)), 0) FROM messages m
       WHERE m.conversation_id = c.id AND m.role = 'assistant' AND json_valid(m.tool_calls)
         AND json_type(m.tool_calls) = 'array') AS tool_call_count,
    (SELECT COUNT(*) ${LIVE_FEEDBACK} AND f.rating = 'up') AS up_count,
    (SELECT COUNT(*) ${LIVE_FEEDBACK} AND f.rating = 'down') AS down_count,
    (SELECT COUNT(*) ${LIVE_FEEDBACK} AND f.correction IS NOT NULL AND trim(f.correction) <> '') AS correction_count
  FROM conversations c
  WHERE (?1 IS NULL OR c.training_status = ?1) AND (?2 IS NULL OR c.kind = ?2)
  ORDER BY c.updated_at DESC, c.created_at DESC, c.id
  LIMIT ?3`;

function toView(row: Row): TrainingConversationView {
  return {
    id: String(row.id),
    title: String(row.title),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    kind: row.kind === "eval" || row.kind === "distill" ? row.kind : "chat",
    trainingStatus: row.training_status === "approved" || row.training_status === "excluded" ? row.training_status : "unreviewed",
    model: (row.model as string | null) ?? null,
    messageCount: Number(row.message_count),
    toolCallCount: Number(row.tool_call_count),
    upCount: Number(row.up_count),
    downCount: Number(row.down_count),
    correctionCount: Number(row.correction_count),
  };
}

/** Newest first, at most 500. */
export function listReviewQueue(filters: ReviewFilters = {}): TrainingConversationView[] {
  const rows = database()
    .prepare(QUERY)
    .all(filters.status ?? null, filters.kind ?? null, REVIEW_QUEUE_LIMIT) as Row[];
  return rows.map(toView);
}
