"use client";

import clsx from "clsx";
import { Brain, ChevronRight } from "lucide-react";
import { useId, useState } from "react";

type ThinkingBlockProps = {
  reasoning: string;
  /** The model is still reasoning: nothing else of its answer has arrived yet. */
  active: boolean;
};

/** Expanded while the model reasons, collapsed once the answer starts; a click overrides either. */
export function ThinkingBlock({ reasoning, active }: ThinkingBlockProps) {
  const [userExpanded, setUserExpanded] = useState<boolean | null>(null);
  const expanded = userExpanded ?? active;
  const panelId = useId();

  return (
    <div className={clsx("thinking", active && "thinking--active")}>
      <button
        type="button"
        className="thinking__toggle"
        aria-expanded={expanded}
        aria-controls={panelId}
        onClick={() => setUserExpanded(!expanded)}
      >
        <Brain size={15} aria-hidden="true" />
        <span>{active ? "Thinking" : "Thought for a moment"}</span>
        {active && <span className="thinking__pulse" aria-hidden="true" />}
        <ChevronRight size={14} aria-hidden="true" className="thinking__chevron" />
      </button>
      <div id={panelId} className="thinking__body" hidden={!expanded}>
        {reasoning}
      </div>
    </div>
  );
}
