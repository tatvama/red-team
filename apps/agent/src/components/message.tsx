"use client";

import { History } from "lucide-react";
import { memo, useState } from "react";
import type { AssistantMessageView, CheckpointView, FeedbackView, SubagentView, UserMessageView } from "@/lib/contract";
import { findFeedback } from "@/lib/client/feedback";
import { type ApprovalDecision, ApprovalCard } from "./approval-card";
import { BrandMark } from "./brand";
import { type FeedbackHandler, MessageFeedback } from "./feedback-controls";
import { Markdown } from "./markdown";
import { ThinkingBlock } from "./thinking-block";
import { ToolCard } from "./tool-card";

const LONG_MESSAGE_LINES = 14;
const LONG_MESSAGE_CHARS = 1500;

type UserMessageProps = {
  message: UserMessageView;
  /** The `turn` checkpoint taken before the agent handled this message. */
  checkpoint?: CheckpointView;
  onRewind?: (checkpoint: CheckpointView) => void;
  rewindDisabled?: boolean;
};

export const UserMessage = memo(function UserMessage({
  message,
  checkpoint,
  onRewind,
  rewindDisabled = false,
}: UserMessageProps) {
  const [expanded, setExpanded] = useState(false);
  const long =
    message.content.length > LONG_MESSAGE_CHARS || message.content.split("\n").length > LONG_MESSAGE_LINES;
  return (
    <div className="message message--user">
      <h2 className="sr-only">You</h2>
      <div className={long && !expanded ? "user-bubble user-bubble--clamped" : "user-bubble"}>{message.content}</div>
      {long && (
        <button type="button" className="link-button" onClick={() => setExpanded(!expanded)}>
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
      {checkpoint && onRewind && (
        <div className="message__actions">
          <button
            type="button"
            className="message-action"
            disabled={rewindDisabled}
            onClick={() => onRewind(checkpoint)}
          >
            <History size={13} aria-hidden="true" />
            Rewind to here
          </button>
        </div>
      )}
    </div>
  );
});

type AssistantMessageProps = {
  message: AssistantMessageView;
  /** This message is receiving streamed output right now. */
  streaming: boolean;
  /** First assistant message after a user message: shows the avatar. */
  showAvatar: boolean;
  onDecision: (callId: string, decision: ApprovalDecision) => void;
  approvalsDisabled: boolean;
  /** `tool` checkpoints keyed by tool call id. */
  toolCheckpoints?: ReadonlyMap<string, CheckpointView>;
  /** Sub-agents keyed by the id of the `delegate_tasks` call that started them. */
  subagentsByCall?: ReadonlyMap<string, SubagentView[]>;
  onRestore?: (checkpoint: CheckpointView) => void;
  restoreDisabled?: boolean;
  /** Feedback on this reply and its tool calls. */
  feedback?: readonly FeedbackView[];
  /** Enables rating and corrections once the reply is finished. */
  onFeedback?: FeedbackHandler;
  /** Shows which model wrote the reply (when the router picks models). */
  showModel?: boolean;
};

const noFeedback: readonly FeedbackView[] = [];

export const AssistantMessage = memo(function AssistantMessage({
  message,
  streaming,
  showAvatar,
  onDecision,
  approvalsDisabled,
  toolCheckpoints,
  subagentsByCall,
  onRestore,
  restoreDisabled,
  feedback = noFeedback,
  onFeedback,
  showModel = false,
}: AssistantMessageProps) {
  const thinking = streaming && message.content === "" && message.toolCalls.length === 0;
  const finished =
    !streaming && message.toolCalls.every((call) => call.status !== "awaiting_approval" && call.status !== "running");
  const showFeedback = finished && onFeedback !== undefined && message.content.trim() !== "";
  return (
    <div className="message message--assistant">
      <div className="message__avatar" aria-hidden="true">
        {showAvatar && <BrandMark size={24} />}
      </div>
      <div className="message__body">
        {showAvatar && <h2 className="sr-only">Tatvam</h2>}
        {message.reasoning && <ThinkingBlock reasoning={message.reasoning} active={thinking} />}
        {message.content && <Markdown text={message.content} />}
        {message.toolCalls.length > 0 && (
          <div className="tool-list">
            {message.toolCalls.map((call) =>
              call.status === "awaiting_approval" ? (
                <ApprovalCard key={call.id} call={call} onDecision={onDecision} disabled={approvalsDisabled} />
              ) : (
                <ToolCard
                  key={call.id}
                  call={call}
                  checkpoint={toolCheckpoints?.get(call.id)}
                  onRestore={onRestore}
                  restoreDisabled={restoreDisabled}
                  subagents={subagentsByCall?.get(call.id)}
                  messageId={onFeedback && finished ? message.id : undefined}
                  feedback={findFeedback(feedback, message.id, call.id)}
                  onFeedback={onFeedback}
                />
              ),
            )}
          </div>
        )}
        {message.interrupted && <p className="message__note">Stopped</p>}
        {showFeedback && (
          <MessageFeedback
            messageId={message.id}
            content={message.content}
            feedback={findFeedback(feedback, message.id, null)}
            onFeedback={onFeedback}
            model={showModel ? message.model : null}
          />
        )}
      </div>
    </div>
  );
});
