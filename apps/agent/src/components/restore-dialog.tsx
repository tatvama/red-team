"use client";

import { CircleAlert, X } from "lucide-react";
import { useCallback, useId, useRef, useState } from "react";
import type { CheckpointView } from "@/lib/contract";
import { errorMessage } from "@/lib/client/api";
import { CheckpointIcon } from "./checkpoint-timeline";
import { useDialog } from "./use-dialog";

type RestoreDialogProps = {
  checkpoint: CheckpointView;
  /** Offer rewinding the conversation too. Only `turn` checkpoints support it. */
  allowRewind: boolean;
  /** Performs the restore. Rejects with a user-facing error to keep the dialog open. */
  onConfirm: (rewindConversation: boolean) => Promise<void>;
  onClose: () => void;
};

type Choice = { rewind: boolean; title: string; description: string };

export function RestoreDialog({ checkpoint, allowRewind, onConfirm, onClose }: RestoreDialogProps) {
  const [pending, setPending] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const baseId = useId();
  const canRewind = allowRewind && checkpoint.kind === "turn";

  const close = useCallback(() => {
    if (pending === null) onClose();
  }, [pending, onClose]);
  useDialog(dialogRef, close);

  const choices: Choice[] = canRewind
    ? [
        {
          rewind: true,
          title: "Restore files and conversation",
          description:
            "Files go back to how they were before this message. The message and everything after it are removed, and the message returns to the composer.",
        },
        {
          rewind: false,
          title: "Restore files only",
          description: "Files go back to how they were before this message. The conversation stays as it is.",
        },
      ]
    : [
        {
          rewind: false,
          title: "Restore files",
          description: "Files go back to how they were at this point. The conversation stays as it is.",
        },
      ];

  async function choose(rewind: boolean) {
    setPending(rewind);
    setError(null);
    try {
      await onConfirm(rewind);
    } catch (caught) {
      setError(errorMessage(caught, "The checkpoint could not be restored. Please try again."));
      setPending(null);
    }
  }

  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div
        ref={dialogRef}
        className="dialog dialog--compact"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${baseId}-title`}
        aria-describedby={`${baseId}-intro`}
      >
        <header className="dialog__header">
          <h2 id={`${baseId}-title`}>{canRewind ? "Rewind to here" : "Restore files"}</h2>
          <button type="button" className="icon-button" aria-label="Close" onClick={close}>
            <X size={18} aria-hidden="true" />
          </button>
        </header>
        <div className="dialog__content">
          <p id={`${baseId}-intro`} className="restore-dialog__intro">
            Changes made in the workspace after this checkpoint are replaced, including your own edits.
          </p>
          <p className="restore-dialog__checkpoint">
            <CheckpointIcon kind={checkpoint.kind} />
            <span>{checkpoint.label}</span>
          </p>
          <div className="restore-choices">
            {choices.map((choice, index) => (
              <button
                key={String(choice.rewind)}
                type="button"
                className="restore-choice"
                aria-labelledby={`${baseId}-choice-${index}`}
                aria-describedby={`${baseId}-choice-${index}-description`}
                data-autofocus={index === 0 ? true : undefined}
                disabled={pending !== null}
                onClick={() => void choose(choice.rewind)}
              >
                <span id={`${baseId}-choice-${index}`} className="restore-choice__title">
                  {choice.title}
                </span>
                <span id={`${baseId}-choice-${index}-description`} className="restore-choice__description">
                  {choice.description}
                </span>
              </button>
            ))}
          </div>
          {error && (
            <p className="restore-dialog__error" role="alert">
              <CircleAlert size={15} aria-hidden="true" />
              <span>{error}</span>
            </p>
          )}
        </div>
        <footer className="dialog__footer">
          <span className="dialog__status" aria-live="polite">
            {pending !== null && "Restoring…"}
          </span>
          <button type="button" className="button button--ghost" onClick={close} disabled={pending !== null}>
            Cancel
          </button>
        </footer>
      </div>
    </div>
  );
}
