"use client";

import clsx from "clsx";
import type { LucideIcon } from "lucide-react";
import type { KeyboardEvent } from "react";

export type SegmentedOption<T extends string> = {
  value: T;
  label: string;
  icon?: LucideIcon;
};

type SegmentedProps<T extends string> = {
  /** Accessible name of the group. */
  label: string;
  value: T;
  options: readonly SegmentedOption<T>[];
  onChange: (value: T) => void;
  /** Smaller control for toolbars. */
  compact?: boolean;
  disabled?: boolean;
  /** Id of an element that describes the group, for example a tooltip. */
  describedBy?: string;
  className?: string;
};

/** A radio group drawn as a segmented control. Arrow keys move the selection, as for native radios. */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  compact = false,
  disabled = false,
  describedBy,
  className,
}: SegmentedProps<T>) {
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const step =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;
    if (!step || disabled) return;
    event.preventDefault();
    const index = options.findIndex((option) => option.value === value);
    const next = options[(index + step + options.length) % options.length];
    onChange(next.value);
    event.currentTarget.querySelector<HTMLElement>(`[data-value="${next.value}"]`)?.focus();
  }

  return (
    <div
      className={clsx("segmented", compact && "segmented--compact", className)}
      role="radiogroup"
      aria-label={label}
      aria-describedby={describedBy}
      onKeyDown={onKeyDown}
    >
      {options.map((option) => {
        const Icon = option.icon;
        const checked = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            data-value={option.value}
            aria-checked={checked}
            // The text label may be hidden on narrow screens; the name must survive that.
            aria-label={Icon ? option.label : undefined}
            tabIndex={checked ? 0 : -1}
            disabled={disabled}
            className={clsx("segmented__option", checked && "segmented__option--active")}
            onClick={() => onChange(option.value)}
          >
            {Icon && <Icon size={14} aria-hidden="true" />}
            <span className="segmented__label">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
