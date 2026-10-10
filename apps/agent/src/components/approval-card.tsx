"use client";

import { ShieldAlert } from "lucide-react";
import { useId } from "react";
import type { ApprovalRequest, ToolCallView, ToolRisk } from "@/lib/contract";
import { ToolDetails, ToolIcon } from "./tool-card";

export type ApprovalDecision = ApprovalRequest["decision"];

const risks: Record<ToolRisk, { label: string; explanation: string }> = {
  read: { label: "Reads files", explanation: "This will read files in your workspace." },
  write: { label: "Edits files", explanation: "This will change files in your workspace." },
  execute: { label: "Runs a command", explanation: "This will run a command in your workspace." },
  network: { label: "Contacts the internet", explanation: "This will send a request to the internet." },
};

type ApprovalCardProps = {
  call: ToolCallView;
  onDecision: (callId: string, decision: ApprovalDecision) => void;
  /** True while a decision is being sent or the agent is running. */
  disabled: boolean;
};

export function ApprovalCard({ call, onDecision, disabled }: ApprovalCardProps) {
  const headingId = useId();
  const risk = risks[call.risk];
  return (
    <section className="approval-card" aria-labelledby={headingId}>
      <header className="approval-card__header">
        <span className="approval-card__icon">
          <ToolIcon name={call.name} risk={call.risk} size={16} />
        </span>
        <div className="approval-card__heading">
          <p className="approval-card__eyebrow">Needs your approval</p>
          <h3 id={headingId}>{call.summary || call.title || call.name}</h3>
          <p className="approval-card__explanation">
            {call.title && call.summary ? `${call.title}. ` : ""}
            {risk.explanation}
          </p>
        </div>
        <span className={`risk-badge risk-badge--${call.risk}`}>
          <ShieldAlert size={13} aria-hidden="true" />
          {risk.label}
        </span>
      </header>
      <div className="approval-card__details">
        <ToolDetails call={call} />
      </div>
      <div className="approval-card__actions">
        <button
          type="button"
          className="button button--primary"
          autoFocus
          disabled={disabled}
          onClick={() => onDecision(call.id, "approve")}
        >
          Approve
        </button>
        <button
          type="button"
          className="button button--secondary"
          disabled={disabled}
          onClick={() => onDecision(call.id, "approve_always")}
        >
          Always allow in this chat
        </button>
        <button
          type="button"
          className="button button--ghost"
          disabled={disabled}
          onClick={() => onDecision(call.id, "deny")}
        >
          Deny
        </button>
      </div>
    </section>
  );
}
