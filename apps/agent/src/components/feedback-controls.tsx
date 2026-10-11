"use client";

import clsx from "clsx";
import { Check, CircleAlert, Cpu, PencilLine, ThumbsDown, ThumbsUp, X } from "lucide-react";
import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import type { FeedbackRequest, FeedbackView } from "@/lib/contract";
import { errorMessage } from "@/lib/client/api";
import { ratingRequest } from "@/lib/client/feedback";

/** Saves feedback. Updates the view optimistically and rejects (after reverting) when the save fails. */
export type FeedbackHandler = (request: FeedbackRequest) => Promise<void>;

const CORRECTION_LIMIT = 50_000;
const NOTE_LIMIT = 2000;

type RatingButtonsProps = {
  rating: FeedbackView["rating"];
  onRate: (rating: "up" | "down") => void;
  upLabel: string;
  downLabel: string;
  small?: boolean;
};

/** Thumbs up and down as toggle buttons; the active one stays highlighted. */
export function RatingButtons({ rating, onRate, upLabel, downLabel, small = false }: RatingButtonsProps) {
  const size = small ? 13 : 15;
  return (
    <span className={clsx("rating", small && "rating--small")}>
      <button
        type="button"
        className={clsx("rating__button", rating === "up" && "rating__button--up")}
        aria-pressed={rating === "up"}
        aria-label={upLabel}
        title={upLabel}
        onClick={() => onRate("up")}
      >
        <ThumbsUp size={size} aria-hidden="true" />
      </button>
      <button
        type="button"
        className={clsx("rating__button", rating === "down" && "rating__button--down")}
        aria-pressed={rating === "down"}
        aria-label={downLabel}
        title={downLabel}
        onClick={() => onRate("down")}
      >
        <ThumbsDown size={size} aria-hidden="true" />
      </button>
    </span>
  );
}

export function FeedbackError({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <p className="feedback-error" role="alert">
      <CircleAlert size={14} aria-hidden="true" />
      <span className="feedback-error__text">{message}</span>
      <button type="button" className="icon-button feedback-error__dismiss" aria-label="Dismiss" onClick={onDismiss}>
        <X size={13} aria-hidden="true" />
      </button>
    </p>
  );
}

type CorrectionEditorProps = {
  original: string;
  feedback: FeedbackView | null;
  messageId: string;
  onFeedback: FeedbackHandler;
  onClose: () => void;
};

function CorrectionEditor({ original, feedback, messageId, onFeedback, onClose }: CorrectionEditorProps) {
  const [text, setText] = useState(feedback?.correction ?? original);
  const [note, setNote] = useState(feedback?.note ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const id = useId();

  useEffect(() => {
    const element = textRef.current;
    if (!element) return;
    element.focus();
    element.setSelectionRange(element.value.length, element.value.length);
  }, []);

  const trimmed = text.trim();
  const unchanged = trimmed === original.trim() && !feedback?.correction;
  const canSave = trimmed.length > 0 && !unchanged && !saving;

  async function submit(request: FeedbackRequest) {
    setSaving(true);
    setError(null);
    try {
      await onFeedback(request);
      onClose();
    } catch (caught) {
      setError(errorMessage(caught, "Your correction could not be saved. Please try again."));
      setSaving(false);
    }
  }

  function save() {
    if (!canSave) return;
    void submit({
      messageId,
      toolCallId: null,
      rating: feedback?.rating ?? null,
      correction: text,
      note: note.trim() ? note.trim() : null,
    });
  }

  function remove() {
    void submit({ messageId, toolCallId: null, rating: feedback?.rating ?? null, correction: null, note: null });
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
    } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      save();
    }
  }

  return (
    <div className="correction-editor" role="group" aria-labelledby={`${id}-title`} onKeyDown={onKeyDown}>
      <h3 id={`${id}-title`} className="correction-editor__title">
        Suggest a better answer
      </h3>
      <p className="correction-editor__hint">
        Rewrite the reply the way it should have been. Corrections become training targets.
      </p>
      <label htmlFor={`${id}-text`} className="field-label">
        Better answer
      </label>
      <textarea
        ref={textRef}
        id={`${id}-text`}
        className="field field--textarea correction-editor__text"
        value={text}
        maxLength={CORRECTION_LIMIT}
        rows={8}
        onChange={(event) => setText(event.target.value)}
      />
      {unchanged && trimmed.length > 0 && (
        <p className="correction-editor__hint">Edit the text to save a correction.</p>
      )}
      <label htmlFor={`${id}-note`} className="field-label">
        Note <span className="field-label__optional">(optional)</span>
      </label>
      <input
        id={`${id}-note`}
        className="field"
        value={note}
        maxLength={NOTE_LIMIT}
        placeholder="What was wrong with the original?"
        onChange={(event) => setNote(event.target.value)}
      />
      {error && <FeedbackError message={error} onDismiss={() => setError(null)} />}
      <div className="correction-editor__actions">
        {feedback?.correction && (
          <button type="button" className="button button--ghost button--small" disabled={saving} onClick={remove}>
            Remove correction
          </button>
        )}
        <span className="correction-editor__spacer" />
        <button type="button" className="button button--ghost button--small" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="button button--primary button--small" disabled={!canSave} onClick={save}>
          {saving ? "Saving…" : "Save correction"}
        </button>
      </div>
    </div>
  );
}

type MessageFeedbackProps = {
  messageId: string;
  /** The reply's text, the starting point for a correction. */
  content: string;
  feedback: FeedbackView | null;
  onFeedback: FeedbackHandler;
  /** The model that wrote this reply, shown when the router picked it. */
  model?: string | null;
};

/** Rating, "Suggest a better answer" and the correction state under a finished reply. */
export function MessageFeedback({ messageId, content, feedback, onFeedback, model }: MessageFeedbackProps) {
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const suggestRef = useRef<HTMLButtonElement>(null);
  const corrected = Boolean(feedback?.correction);

  async function rate(rating: "up" | "down") {
    setError(null);
    try {
      await onFeedback(ratingRequest(feedback, { messageId, toolCallId: null }, rating));
    } catch (caught) {
      setError(errorMessage(caught, "Your rating could not be saved. Please try again."));
    }
  }

  function closeEditor() {
    setEditing(false);
    requestAnimationFrame(() => suggestRef.current?.focus());
  }

  return (
    <div className="message-feedback">
      <div className="message-feedback__bar">
        <RatingButtons
          rating={feedback?.rating ?? null}
          onRate={(rating) => void rate(rating)}
          upLabel="Good response"
          downLabel="Bad response"
        />
        <button
          ref={suggestRef}
          type="button"
          className="feedback-action"
          aria-expanded={editing}
          onClick={() => (editing ? closeEditor() : setEditing(true))}
        >
          <PencilLine size={14} aria-hidden="true" />
          {corrected ? "Edit correction" : "Suggest a better answer"}
        </button>
        {corrected && (
          <span className="badge badge--success feedback-corrected">
            <Check size={12} aria-hidden="true" />
            Corrected
          </span>
        )}
        {model && (
          <span className="message-feedback__model" title={`Answered by ${model}`}>
            <Cpu size={12} aria-hidden="true" />
            <span className="sr-only">Answered by </span>
            <span className="message-feedback__model-name">{model}</span>
          </span>
        )}
      </div>
      {error && <FeedbackError message={error} onDismiss={() => setError(null)} />}
      {editing && (
        <CorrectionEditor
          original={content}
          feedback={feedback}
          messageId={messageId}
          onFeedback={onFeedback}
          onClose={closeEditor}
        />
      )}
    </div>
  );
}

type ToolFeedbackProps = {
  messageId: string;
  toolCallId: string;
  feedback: FeedbackView | null;
  onFeedback: FeedbackHandler;
  onError: (message: string | null) => void;
};

/** Small thumbs for one tool call. Errors are reported to the card, which shows them under its header. */
export function ToolFeedback({ messageId, toolCallId, feedback, onFeedback, onError }: ToolFeedbackProps) {
  async function rate(rating: "up" | "down") {
    onError(null);
    try {
      await onFeedback(ratingRequest(feedback, { messageId, toolCallId }, rating));
    } catch (caught) {
      onError(errorMessage(caught, "Your rating could not be saved. Please try again."));
    }
  }

  return (
    <RatingButtons
      small
      rating={feedback?.rating ?? null}
      onRate={(rating) => void rate(rating)}
      upLabel="Good tool call"
      downLabel="Bad tool call"
    />
  );
}

