"use client";

import { ArrowUp, FileText, Paperclip, Square, X } from "lucide-react";
import { type KeyboardEvent, type ReactNode, type RefObject, useLayoutEffect, useRef, useState } from "react";
import { type Attachment, appendAttachments, readTextAttachment } from "@/lib/client/attachments";
import { formatBytes } from "@/lib/client/format";

/** Mirrors the server's limit on one message. */
const MAX_MESSAGE_CHARS = 100_000;

type ComposerProps = {
  value: string;
  onChange: (value: string) => void;
  onSend: (content: string) => void;
  onStop: () => void;
  running: boolean;
  /** False when no model is available or the conversation cannot take messages. */
  canSend: boolean;
  /** Explains why sending is unavailable. */
  hint?: ReactNode;
  /** Model and permission pickers. */
  toolbar: ReactNode;
  inputRef: RefObject<HTMLTextAreaElement | null>;
};

export function Composer({ value, onChange, onSend, onStop, running, canSend, hint, toolbar, inputRef }: ComposerProps) {
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const nextAttachmentId = useRef(0);

  const hasContent = value.trim().length > 0 || attachments.length > 0;
  const sendDisabled = !canSend || running || !hasContent;

  // Grow with the content; CSS caps the height and scrolls beyond it.
  useLayoutEffect(() => {
    const textarea = inputRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, [value, inputRef]);

  function submit() {
    if (sendDisabled) return;
    const content = appendAttachments(value, attachments);
    if (content.length > MAX_MESSAGE_CHARS) {
      setAttachError("This message is too long. Shorten it or attach fewer files.");
      return;
    }
    onSend(content);
    setAttachments([]);
    setAttachError(null);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // keyCode 229 covers IME composition in browsers that do not set isComposing on keydown.
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    submit();
  }

  async function onFilesPicked(files: FileList | null) {
    if (!files || files.length === 0) return;
    const results = await Promise.all(
      Array.from(files, (file) => readTextAttachment(file, `file-${nextAttachmentId.current++}`)),
    );
    const added = results.flatMap((result) => (result.ok ? [result.attachment] : []));
    const errors = results.flatMap((result) => (result.ok ? [] : [result.error]));
    setAttachments((current) => [...current, ...added]);
    setAttachError(errors.length > 0 ? errors.join(" ") : null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  return (
    <form
      className="composer"
      aria-label="Message Tatvam"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {attachments.length > 0 && (
        <ul className="attachments" aria-label="Attached files">
          {attachments.map((file) => (
            <li key={file.id} className="attachment-chip">
              <FileText size={14} aria-hidden="true" />
              <span className="attachment-chip__name">{file.name}</span>
              <span className="attachment-chip__size">{formatBytes(file.size)}</span>
              <button
                type="button"
                className="attachment-chip__remove"
                aria-label={`Remove ${file.name}`}
                onClick={() => setAttachments((current) => current.filter((item) => item.id !== file.id))}
              >
                <X size={13} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <label htmlFor="composer-input" className="sr-only">
        Message
      </label>
      <textarea
        id="composer-input"
        ref={inputRef}
        className="composer__input"
        rows={1}
        value={value}
        placeholder="Ask Tatvam to build, fix or explore…"
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
      />
      {attachError && (
        <p className="composer__error" role="alert">
          {attachError}
        </p>
      )}
      <div className="composer__toolbar">
        <button
          type="button"
          className="icon-button"
          aria-label="Attach text files"
          title="Attach text files (up to 200 KB each)"
          onClick={() => fileInputRef.current?.click()}
        >
          <Paperclip size={17} aria-hidden="true" />
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          tabIndex={-1}
          aria-hidden="true"
          onChange={(event) => void onFilesPicked(event.target.files)}
        />
        <div className="composer__pickers">{toolbar}</div>
        {running ? (
          <button type="button" className="send-button send-button--stop" aria-label="Stop" onClick={onStop}>
            <Square size={14} aria-hidden="true" fill="currentColor" />
          </button>
        ) : (
          <button type="submit" className="send-button" aria-label="Send message" disabled={sendDisabled}>
            <ArrowUp size={18} aria-hidden="true" />
          </button>
        )}
      </div>
      {hint && <div className="composer__hint">{hint}</div>}
    </form>
  );
}
