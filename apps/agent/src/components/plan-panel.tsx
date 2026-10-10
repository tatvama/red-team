"use client";

import clsx from "clsx";
import { ChevronDown, CircleCheck, Circle, ListChecks, X } from "lucide-react";
import { useId, useState } from "react";
import type { PlanItem } from "@/lib/contract";

export function planProgress(plan: PlanItem[]): string {
  const done = plan.filter((item) => item.status === "completed").length;
  return `${done} of ${plan.length}`;
}

function PlanChecklist({ plan }: { plan: PlanItem[] }) {
  return (
    <ol className="plan-list">
      {plan.map((item, index) => (
        <li key={index} className={clsx("plan-item", `plan-item--${item.status}`)}>
          <span className="plan-item__marker" aria-hidden="true">
            {item.status === "completed" ? (
              <CircleCheck size={16} />
            ) : item.status === "in_progress" ? (
              <span className="plan-item__dot" />
            ) : (
              <Circle size={16} />
            )}
          </span>
          <span className="plan-item__text">
            {item.step}
            <span className="sr-only">
              {item.status === "completed" ? " (done)" : item.status === "in_progress" ? " (in progress)" : ""}
            </span>
          </span>
        </li>
      ))}
    </ol>
  );
}

/** Right rail on wide screens. */
export function PlanPanel({ plan, onClose }: { plan: PlanItem[]; onClose: () => void }) {
  return (
    <aside className="plan-rail" aria-label="Plan">
      <header className="plan-rail__header">
        <ListChecks size={16} aria-hidden="true" />
        <h2>Plan</h2>
        <span className="plan-progress">{planProgress(plan)}</span>
        <button type="button" className="icon-button" aria-label="Hide plan" onClick={onClose}>
          <X size={16} aria-hidden="true" />
        </button>
      </header>
      <PlanChecklist plan={plan} />
    </aside>
  );
}

/** Collapsible bar above the composer on narrower screens. */
export function PlanBar({ plan }: { plan: PlanItem[] }) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const current = plan.find((item) => item.status === "in_progress") ?? plan.find((item) => item.status === "pending");
  return (
    <div className={clsx("plan-bar", open && "plan-bar--open")}>
      <button
        type="button"
        className="plan-bar__toggle"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen(!open)}
      >
        <ListChecks size={15} aria-hidden="true" />
        <span className="plan-bar__current">{current ? current.step : "Plan complete"}</span>
        <span className="plan-progress">{planProgress(plan)}</span>
        <ChevronDown size={15} aria-hidden="true" className="plan-bar__chevron" />
      </button>
      <div id={listId} className="plan-bar__list" hidden={!open}>
        <PlanChecklist plan={plan} />
      </div>
    </div>
  );
}
