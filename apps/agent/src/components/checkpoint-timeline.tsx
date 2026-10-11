"use client";

import { History, MessageSquare, Wrench } from "lucide-react";
import type { CheckpointView } from "@/lib/contract";
import { formatTimestamp } from "@/lib/client/format";

export const checkpointKindLabels: Record<CheckpointView["kind"], string> = {
  turn: "Before a message",
  tool: "Before a file edit or command",
};

export function CheckpointIcon({ kind, size = 15 }: { kind: CheckpointView["kind"]; size?: number }) {
  const Icon = kind === "turn" ? MessageSquare : Wrench;
  return <Icon size={size} aria-hidden="true" />;
}

/** Newest first; checkpoints with the same timestamp keep their newest-last server order reversed. */
export function newestFirst(checkpoints: CheckpointView[]): CheckpointView[] {
  return [...checkpoints].reverse().sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}

type CheckpointTimelineProps = {
  checkpoints: CheckpointView[];
  /** True while the agent runs: restoring then would race the agent's own edits. */
  disabled: boolean;
  onRestore: (checkpoint: CheckpointView, rewindConversation: boolean) => void;
};

export function CheckpointTimeline({ checkpoints, disabled, onRestore }: CheckpointTimelineProps) {
  if (checkpoints.length === 0) {
    return (
      <div className="panel-empty">
        <History size={20} aria-hidden="true" />
        <p>No checkpoints yet. Tatvam saves one before each message and before each file edit or command.</p>
      </div>
    );
  }
  return (
    <ol className="timeline" aria-label="Checkpoints, newest first">
      {newestFirst(checkpoints).map((checkpoint) => (
        <li key={checkpoint.id} className={`timeline-item timeline-item--${checkpoint.kind}`}>
          <span className="timeline-item__icon" title={checkpointKindLabels[checkpoint.kind]}>
            <CheckpointIcon kind={checkpoint.kind} />
          </span>
          <div className="timeline-item__body">
            <p className="timeline-item__label">{checkpoint.label}</p>
            <p className="timeline-item__meta">
              <span>{checkpointKindLabels[checkpoint.kind]}</span>
              <span aria-hidden="true"> · </span>
              <time dateTime={checkpoint.createdAt}>{formatTimestamp(checkpoint.createdAt)}</time>
            </p>
            <div className="timeline-item__actions">
              <button
                type="button"
                className="button button--secondary button--small"
                disabled={disabled}
                aria-label={`Restore files: ${checkpoint.label}`}
                onClick={() => onRestore(checkpoint, false)}
              >
                Restore files
              </button>
              {checkpoint.kind === "turn" && (
                <button
                  type="button"
                  className="button button--ghost button--small"
                  disabled={disabled}
                  aria-label={`Rewind conversation here: ${checkpoint.label}`}
                  onClick={() => onRestore(checkpoint, true)}
                >
                  Rewind conversation here
                </button>
              )}
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}
