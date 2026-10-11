import type { FeedbackRequest, FeedbackView } from "@/lib/contract";

/** The feedback on one reply (toolCallId null) or on one of its tool calls. */
export function findFeedback(
  feedback: readonly FeedbackView[],
  messageId: string,
  toolCallId: string | null,
): FeedbackView | null {
  return feedback.find((entry) => entry.messageId === messageId && entry.toolCallId === toolCallId) ?? null;
}

/** Replaces, adds or (with `entry` null) removes the entry for one reply or tool call. */
export function replaceFeedback(
  feedback: readonly FeedbackView[],
  messageId: string,
  toolCallId: string | null,
  entry: FeedbackView | null,
): FeedbackView[] {
  const rest = feedback.filter((item) => !(item.messageId === messageId && item.toolCallId === toolCallId));
  return entry ? [...rest, entry] : rest;
}

/** A request with nothing in it clears the feedback on the server. */
export function isEmptyFeedback(request: Pick<FeedbackRequest, "rating" | "correction" | "note">): boolean {
  return request.rating === null && request.correction === null && request.note === null;
}

/** What the server will store for this request, shown before it answers. */
export function optimisticFeedback(request: FeedbackRequest, now = new Date()): FeedbackView | null {
  if (isEmptyFeedback(request)) return null;
  return { ...request, updatedAt: now.toISOString() };
}

/**
 * A request that changes only the rating and keeps any correction and note.
 * Choosing the active rating again turns it off.
 */
export function ratingRequest(
  current: FeedbackView | null,
  target: { messageId: string; toolCallId: string | null },
  rating: "up" | "down",
): FeedbackRequest {
  return {
    messageId: target.messageId,
    toolCallId: target.toolCallId,
    rating: current?.rating === rating ? null : rating,
    correction: current?.correction ?? null,
    note: current?.note ?? null,
  };
}

/** Groups entries by reply so each message receives only its own feedback. */
export function feedbackByMessage(feedback: readonly FeedbackView[]): Map<string, FeedbackView[]> {
  const byMessage = new Map<string, FeedbackView[]>();
  for (const entry of feedback) {
    const list = byMessage.get(entry.messageId);
    if (list) list.push(entry);
    else byMessage.set(entry.messageId, [entry]);
  }
  return byMessage;
}
