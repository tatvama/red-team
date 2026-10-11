"use client";

import clsx from "clsx";
import { Ban, Check, ChevronDown, CircleCheck, CircleDashed, type LucideIcon, X } from "lucide-react";
import { useState } from "react";
import type { TrainingStatus } from "@/lib/contract";
import { errorMessage } from "@/lib/client/api";
import { onMenuKeyDown, usePopover } from "./use-popover";

export const trainingStatuses: TrainingStatus[] = ["unreviewed", "approved", "excluded"];

export const trainingStatusLabels: Record<TrainingStatus, string> = {
  unreviewed: "Unreviewed",
  approved: "Approved",
  excluded: "Excluded",
};

const descriptions: Record<TrainingStatus, string> = {
  unreviewed: "Not reviewed yet. Datasets leave it out unless you include unreviewed work.",
  approved: "Good example. Goes into training datasets.",
  excluded: "Never used for training.",
};

export const trainingStatusIcons: Record<TrainingStatus, LucideIcon> = {
  unreviewed: CircleDashed,
  approved: CircleCheck,
  excluded: Ban,
};

export function TrainingStatusChip({ status }: { status: TrainingStatus }) {
  const Icon = trainingStatusIcons[status];
  return (
    <span className={clsx("status-chip", `status-chip--training-${status}`)}>
      <Icon size={13} aria-hidden="true" />
      {trainingStatusLabels[status]}
    </span>
  );
}

type TrainingStatusControlProps = {
  value: TrainingStatus;
  /** Rejects (after the caller reverts its optimistic update) when the server refuses the change. */
  onChange: (status: TrainingStatus) => Promise<void>;
};

/** Header control: whether this conversation may be used for training. */
export function TrainingStatusControl({ value, onChange }: TrainingStatusControlProps) {
  const { open, setOpen, close, triggerRef, panelRef } = usePopover();
  const [error, setError] = useState<string | null>(null);
  const Icon = trainingStatusIcons[value];

  async function choose(status: TrainingStatus) {
    close();
    if (status === value) return;
    setError(null);
    try {
      await onChange(status);
    } catch (caught) {
      setError(errorMessage(caught, "The training status could not be saved. Please try again."));
    }
  }

  return (
    <div className="training-status">
      <button
        ref={triggerRef}
        type="button"
        className={clsx("training-status__trigger", `training-status__trigger--${value}`)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Training status: ${trainingStatusLabels[value]}. Change training status`}
        title="Training status"
        onClick={() => setOpen(!open)}
      >
        <Icon size={14} aria-hidden="true" />
        <span className="training-status__label">{trainingStatusLabels[value]}</span>
        <ChevronDown size={13} aria-hidden="true" />
      </button>
      {open && (
        <div
          ref={panelRef}
          className="popover popover--down training-status__menu"
          role="menu"
          aria-label="Training status"
          onKeyDown={(event) => onMenuKeyDown(event, close)}
        >
          {trainingStatuses.map((status) => {
            const StatusIcon = trainingStatusIcons[status];
            return (
              <button
                key={status}
                type="button"
                role="menuitemradio"
                aria-checked={status === value}
                className={clsx("menu-item menu-item--rich", `training-status__option--${status}`)}
                onClick={() => void choose(status)}
              >
                <span className="training-status__option-icon">
                  <StatusIcon size={15} aria-hidden="true" />
                </span>
                <span className="menu-item__stack">
                  <span className="menu-item__label">{trainingStatusLabels[status]}</span>
                  <span className="menu-item__description">{descriptions[status]}</span>
                </span>
                {status === value && <Check size={15} aria-hidden="true" className="menu-item__check" />}
              </button>
            );
          })}
        </div>
      )}
      {error && (
        <div className="training-status__error" role="alert">
          <span>{error}</span>
          <button type="button" className="icon-button" aria-label="Dismiss" onClick={() => setError(null)}>
            <X size={13} aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  );
}
