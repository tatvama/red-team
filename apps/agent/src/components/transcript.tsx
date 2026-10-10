"use client";

import { ArrowDown, CircleAlert, Play, RotateCcw, X } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CheckpointView, MessageView, SubagentView } from "@/lib/contract";
import type { InlineError } from "@/lib/client/agent-state";
import type { ApprovalDecision } from "./approval-card";
import { BrandMark } from "./brand";
import { AssistantMessage, UserMessage } from "./message";

const STICK_THRESHOLD_PX = 72;

type TranscriptProps = {
  messages: MessageView[];
  running: boolean;
  error: InlineError | null;
  stepLimitReached: boolean;
  onRetry: () => void;
  onDismissError: () => void;
  onDecision: (callId: string, decision: ApprovalDecision) => void;
  approvalsDisabled: boolean;
  /** Shown instead of messages, for example the empty state or a load error. */
  placeholder?: ReactNode;
  checkpoints?: CheckpointView[];
  subagents?: SubagentView[];
  /** Opens the restore dialog; `allowRewind` offers rewinding the conversation as well. */
  onRestore?: (checkpoint: CheckpointView, allowRewind: boolean) => void;
  restoreDisabled?: boolean;
};

const noCheckpoints: CheckpointView[] = [];
const noSubagents: SubagentView[] = [];

function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

export function Transcript({
  messages,
  running,
  error,
  stepLimitReached,
  onRetry,
  onDismissError,
  onDecision,
  approvalsDisabled,
  placeholder,
  checkpoints = noCheckpoints,
  subagents = noSubagents,
  onRestore,
  restoreDisabled = false,
}: TranscriptProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const lastUserId = useRef<string | undefined>(undefined);
  const [showJump, setShowJump] = useState(false);

  const lastUser = messages.findLast((message) => message.role === "user");

  // Lookups shared by every message; rebuilt only when checkpoints or sub-agents change.
  const { turnCheckpoints, toolCheckpoints } = useMemo(() => {
    const turns = new Map<string, CheckpointView>();
    const tools = new Map<string, CheckpointView>();
    for (const checkpoint of checkpoints) {
      if (checkpoint.kind === "turn" && checkpoint.messageId) turns.set(checkpoint.messageId, checkpoint);
      if (checkpoint.kind === "tool" && checkpoint.toolCallId) tools.set(checkpoint.toolCallId, checkpoint);
    }
    return { turnCheckpoints: turns, toolCheckpoints: tools };
  }, [checkpoints]);

  const subagentsByCall = useMemo(() => {
    const byCall = new Map<string, SubagentView[]>();
    for (const subagent of subagents) {
      const list = byCall.get(subagent.toolCallId);
      if (list) list.push(subagent);
      else byCall.set(subagent.toolCallId, [subagent]);
    }
    return byCall;
  }, [subagents]);

  const rewind = useCallback((checkpoint: CheckpointView) => onRestore?.(checkpoint, true), [onRestore]);
  const restoreFiles = useCallback((checkpoint: CheckpointView) => onRestore?.(checkpoint, false), [onRestore]);
  const lastMessage = messages.at(-1);

  // Follow new output unless the reader scrolled up; a new user message always snaps back down.
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    if (lastUser?.id !== lastUserId.current) {
      lastUserId.current = lastUser?.id;
      stickToBottom.current = true;
    }
    if (stickToBottom.current) element.scrollTop = element.scrollHeight;
  }, [messages, running, error, stepLimitReached, lastUser?.id]);

  // The viewport shrinks when the composer grows or a hint appears; stay pinned then too.
  useEffect(() => {
    const element = scrollRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (stickToBottom.current) element.scrollTop = element.scrollHeight;
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  function onScroll() {
    const element = scrollRef.current;
    if (!element) return;
    const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < STICK_THRESHOLD_PX;
    stickToBottom.current = atBottom;
    setShowJump(!atBottom);
  }

  function jumpToLatest() {
    const element = scrollRef.current;
    if (!element) return;
    stickToBottom.current = true;
    element.scrollTo({ top: element.scrollHeight, behavior: prefersReducedMotion() ? "auto" : "smooth" });
  }

  return (
    <div className="transcript-wrap">
      <div className="transcript" ref={scrollRef} onScroll={onScroll}>
        <div className="transcript__inner">
          {messages.length === 0 && placeholder}
          {messages.map((message, index) => {
            if (message.role === "user") {
              return (
                <UserMessage
                  key={message.id}
                  message={message}
                  checkpoint={turnCheckpoints.get(message.id)}
                  onRewind={onRestore ? rewind : undefined}
                  rewindDisabled={restoreDisabled}
                />
              );
            }
            const previous = messages[index - 1];
            return (
              <AssistantMessage
                key={message.id}
                message={message}
                streaming={running && message === lastMessage}
                showAvatar={previous?.role !== "assistant"}
                onDecision={onDecision}
                approvalsDisabled={approvalsDisabled}
                toolCheckpoints={toolCheckpoints}
                subagentsByCall={subagentsByCall}
                onRestore={onRestore ? restoreFiles : undefined}
                restoreDisabled={restoreDisabled}
              />
            );
          })}
          <div className="working" aria-live="polite">
            {running && (
              <>
                <BrandMark size={20} className="working__mark" />
                <span>Working…</span>
              </>
            )}
          </div>
          {stepLimitReached && !running && (
            <div className="banner banner--info">
              <span>Paused after reaching the step limit for one turn.</span>
              <button type="button" className="button button--secondary button--small" onClick={onRetry}>
                <Play size={14} aria-hidden="true" />
                Continue
              </button>
            </div>
          )}
          {error && (
            <div className="banner banner--error" role="alert">
              <CircleAlert size={16} aria-hidden="true" className="banner__icon" />
              <span className="banner__text">{error.message}</span>
              {error.retryable && (
                <button
                  type="button"
                  className="button button--secondary button--small"
                  onClick={onRetry}
                  disabled={running}
                >
                  <RotateCcw size={14} aria-hidden="true" />
                  Retry
                </button>
              )}
              <button type="button" className="icon-button" aria-label="Dismiss error" onClick={onDismissError}>
                <X size={15} aria-hidden="true" />
              </button>
            </div>
          )}
        </div>
      </div>
      {showJump && messages.length > 0 && (
        <button type="button" className="jump-button" onClick={jumpToLatest}>
          <ArrowDown size={14} aria-hidden="true" />
          Jump to latest
        </button>
      )}
    </div>
  );
}
