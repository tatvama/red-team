"use client";

import clsx from "clsx";
import { Ban, CircleCheck, Cpu, RotateCcw } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import type { ConversationKind, TrainingConversationView, TrainingStatus } from "@/lib/contract";
import { errorMessage, fetchTrainingConversations, saveTrainingStatus } from "@/lib/client/api";
import { formatTimestamp } from "@/lib/client/format";
import { Segmented, type SegmentedOption } from "../segmented";
import { TrainingStatusChip } from "../training-status";
import { Alert, formatCount, Loadable, Panel, useResource } from "./common";

type StatusFilter = TrainingStatus | "all";
type KindFilter = ConversationKind | "all";

const statusOptions: SegmentedOption<StatusFilter>[] = [
  { value: "unreviewed", label: "Unreviewed" },
  { value: "approved", label: "Approved" },
  { value: "excluded", label: "Excluded" },
  { value: "all", label: "All" },
];

const kindOptions: SegmentedOption<KindFilter>[] = [
  { value: "all", label: "All kinds" },
  { value: "chat", label: "Chat" },
  { value: "eval", label: "Evaluation" },
  { value: "distill", label: "Distillation" },
];

export const kindLabels: Record<ConversationKind, string> = {
  chat: "Chat",
  eval: "Evaluation",
  distill: "Distillation",
};

const conversationUrl = (id: string) => `/c/${encodeURIComponent(id)}`;

function Count({ value, singular, plural }: { value: number; singular: string; plural?: string }) {
  return <li className={clsx("review-count", value === 0 && "review-count--zero")}>{formatCount(value, singular, plural)}</li>;
}

type RowProps = {
  conversation: TrainingConversationView;
  error: string | undefined;
  onStatus: (status: TrainingStatus) => void;
  onDismissError: () => void;
};

function ReviewRow({ conversation, error, onStatus, onDismissError }: RowProps) {
  const { trainingStatus: status, title } = conversation;
  return (
    <li className={clsx("review-row", `review-row--${status}`)}>
      <div className="review-row__main">
        <Link href={conversationUrl(conversation.id)} className="review-row__title">
          {title}
        </Link>
        <div className="review-row__meta">
          {conversation.kind !== "chat" && <span className="badge badge--info">{kindLabels[conversation.kind]}</span>}
          {conversation.model && (
            <span className="review-row__model">
              <Cpu size={12} aria-hidden="true" />
              {conversation.model}
            </span>
          )}
          <span>{formatTimestamp(conversation.updatedAt)}</span>
        </div>
        <ul className="review-counts" aria-label="Feedback and activity">
          <Count value={conversation.upCount} singular="thumbs up" plural="thumbs up" />
          <Count value={conversation.downCount} singular="thumbs down" plural="thumbs down" />
          <Count value={conversation.correctionCount} singular="correction" />
          <Count value={conversation.toolCallCount} singular="tool call" />
          <Count value={conversation.messageCount} singular="message" />
        </ul>
      </div>
      <div className="review-row__side">
        <TrainingStatusChip status={status} />
        <div className="review-row__actions">
          <button
            type="button"
            className="button button--secondary button--small review-action review-action--approve"
            aria-pressed={status === "approved"}
            aria-label={`Approve ${title}`}
            onClick={() => onStatus(status === "approved" ? "unreviewed" : "approved")}
          >
            <CircleCheck size={14} aria-hidden="true" />
            Approve
          </button>
          <button
            type="button"
            className="button button--secondary button--small review-action review-action--exclude"
            aria-pressed={status === "excluded"}
            aria-label={`Exclude ${title}`}
            onClick={() => onStatus(status === "excluded" ? "unreviewed" : "excluded")}
          >
            <Ban size={14} aria-hidden="true" />
            Exclude
          </button>
        </div>
      </div>
      {error && (
        <div className="review-row__error">
          <Alert message={error} onDismiss={onDismissError} />
        </div>
      )}
    </li>
  );
}

/** The review queue: approve good conversations for training and exclude the rest. */
export function ReviewTab() {
  const [status, setStatus] = useState<StatusFilter>("unreviewed");
  const [kind, setKind] = useState<KindFilter>("all");
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const queue = useResource(
    `${status}/${kind}`,
    () =>
      fetchTrainingConversations({
        status: status === "all" ? null : status,
        kind: kind === "all" ? null : kind,
      }),
    "The review queue could not be loaded.",
  );
  const conversations = queue.data ?? [];

  const setRowError = (id: string, message: string | null) =>
    setRowErrors((current) => {
      const next = { ...current };
      if (message) next[id] = message;
      else delete next[id];
      return next;
    });

  async function changeStatus(conversation: TrainingConversationView, next: TrainingStatus) {
    const previous = conversation.trainingStatus;
    const apply = (value: TrainingStatus, only?: TrainingStatus) =>
      queue.update((list) =>
        list.map((item) =>
          item.id === conversation.id && (only === undefined || item.trainingStatus === only)
            ? { ...item, trainingStatus: value }
            : item,
        ),
      );
    setRowError(conversation.id, null);
    // Rows stay in place after a change, even when the filter no longer matches, so a mistake is easy to undo.
    apply(next);
    try {
      await saveTrainingStatus(conversation.id, next);
    } catch (error) {
      apply(previous, next);
      setRowError(conversation.id, errorMessage(error, "The training status could not be saved. Please try again."));
    }
  }

  return (
    <div className="training-stack">
      <Panel
        title="Review queue"
        description="Approve conversations that show the agent at its best; only approved work goes into datasets by default. Exclude anything that should never be used. Evaluation and distillation conversations open read-only."
        actions={
          <button type="button" className="button button--secondary button--small" onClick={queue.reload}>
            <RotateCcw size={14} aria-hidden="true" />
            Refresh
          </button>
        }
      >
        <div className="review-filters">
          <Segmented label="Training status" value={status} options={statusOptions} onChange={setStatus} compact />
          <Segmented label="Conversation kind" value={kind} options={kindOptions} onChange={setKind} compact />
        </div>
        <Loadable
          loading={queue.loading && queue.data === undefined}
          error={queue.error}
          onRetry={queue.reload}
          what="conversations"
        >
          <p className="review-summary" aria-live="polite">
            {queue.loading ? "Updating…" : formatCount(conversations.length, "conversation")}
          </p>
          {conversations.length === 0 && !queue.loading ? (
            <p className="training-empty">Nothing matches these filters.</p>
          ) : (
            <ul className={clsx("review-list", queue.loading && "review-list--busy")} aria-busy={queue.loading}>
              {conversations.map((conversation) => (
                <ReviewRow
                  key={conversation.id}
                  conversation={conversation}
                  error={rowErrors[conversation.id]}
                  onStatus={(next) => void changeStatus(conversation, next)}
                  onDismissError={() => setRowError(conversation.id, null)}
                />
              ))}
            </ul>
          )}
        </Loadable>
      </Panel>
    </div>
  );
}
