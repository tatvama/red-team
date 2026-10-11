"use client";

import clsx from "clsx";
import {
  Ban,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  Clock,
  LoaderCircle,
  type LucideIcon,
  RotateCcw,
  TriangleAlert,
  X,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from "react";
import {
  type EvalTaskResult,
  type JobStatus,
  type ModelConnection,
  type ModelRef,
  type Provider,
  providerNames,
} from "@/lib/contract";
import { errorMessage } from "@/lib/client/api";
import { providers } from "../model-picker";
import { useDialog } from "../use-dialog";

export type Connections = Record<Provider, ModelConnection | null>;

/** How often running evaluations and distillation jobs are refreshed. */
export const POLL_INTERVAL_MS = 2000;

/** 0.5 → "50%", 0.875 → "87.5%". */
export function formatPercent(value: number): string {
  return `${Math.round(value * 1000) / 10}%`;
}

/** Signed change in percentage points, for example "+12.5 pts". */
export function formatDelta(points: number): string {
  const rounded = Math.round(points * 10) / 10;
  if (rounded === 0) return "±0 pts";
  return `${rounded > 0 ? "+" : "−"}${Math.abs(rounded)} pts`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(Math.round(seconds % 60)).padStart(2, "0")}s`;
}

export function formatCount(value: number, singular: string, plural = `${singular}s`): string {
  return `${value.toLocaleString()} ${value === 1 ? singular : plural}`;
}

/** "snake_case_reason" → "Snake case reason", for server-side keys shown as labels. */
export function humanize(key: string): string {
  const text = key.replace(/[_-]+/g, " ").trim();
  return text ? text[0].toUpperCase() + text.slice(1) : key;
}

export function modelRefLabel(ref: ModelRef): string {
  return `${ref.model} (${providerNames[ref.provider]})`;
}

export const sameModel = (a: ModelRef | null, b: ModelRef | null) =>
  a !== null && b !== null && a.provider === b.provider && a.model === b.model;

// Provider names never contain a colon, so the first colon splits even model ids like "qwen3:8b".
const encodeRef = (ref: ModelRef) => `${ref.provider}:${ref.model}`;

function decodeRef(value: string): ModelRef | null {
  const index = value.indexOf(":");
  if (index === -1) return null;
  const provider = value.slice(0, index);
  const model = value.slice(index + 1);
  return providers.includes(provider as Provider) && model ? { provider: provider as Provider, model } : null;
}

type ModelSelectProps = {
  id: string;
  value: ModelRef | null;
  onChange: (value: ModelRef | null) => void;
  connections: Connections;
  /** Label of the empty choice for optional selects, for example "None". Required selects show a placeholder. */
  emptyLabel?: string;
  disabled?: boolean;
  invalid?: boolean;
  describedBy?: string;
};

/** A model from the connections' model lists, grouped by provider. */
export function ModelSelect({
  id,
  value,
  onChange,
  connections,
  emptyLabel,
  disabled = false,
  invalid = false,
  describedBy,
}: ModelSelectProps) {
  const listed = (ref: ModelRef) => connections[ref.provider]?.models.includes(ref.model) ?? false;
  const ready = providers.filter((provider) => connections[provider]?.state === "ready");
  const checking = providers.some((provider) => connections[provider] === null);
  return (
    <select
      id={id}
      className="field"
      value={value ? encodeRef(value) : ""}
      disabled={disabled}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      onChange={(event) => onChange(event.target.value ? decodeRef(event.target.value) : null)}
    >
      {emptyLabel !== undefined ? (
        <option value="">{emptyLabel}</option>
      ) : (
        <option value="" disabled>
          {ready.length === 0 ? (checking ? "Checking models…" : "No models available") : "Choose a model"}
        </option>
      )}
      {value && !listed(value) && (
        <optgroup label="Not available now">
          <option value={encodeRef(value)}>{modelRefLabel(value)}</option>
        </optgroup>
      )}
      {ready.map((provider) => (
        <optgroup key={provider} label={providerNames[provider]}>
          {(connections[provider]?.models ?? []).map((model) => (
            <option key={model} value={encodeRef({ provider, model })}>
              {model}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

type FieldProps = {
  label: string;
  htmlFor: string;
  hint?: ReactNode;
  hintId?: string;
  error?: string | null;
  errorId?: string;
  optional?: boolean;
  children: ReactNode;
  className?: string;
};

/** A label, the control, an optional hint and a validation message. */
export function Field({ label, htmlFor, hint, hintId, error, errorId, optional, children, className }: FieldProps) {
  return (
    <div className={clsx("form-field", className)}>
      <label htmlFor={htmlFor} className="field-label">
        {label}
        {optional && <span className="field-label__optional"> (optional)</span>}
      </label>
      {children}
      {hint && (
        <p id={hintId} className="form-field__hint">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="form-field__error">
          {error}
        </p>
      )}
    </div>
  );
}

export function ProgressBar({ value, total, label }: { value: number; total: number; label: string }) {
  const percent = total > 0 ? Math.min(100, Math.max(0, (value / total) * 100)) : 0;
  return (
    <div
      className="progress"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={value}
      aria-valuetext={`${value} of ${total}`}
    >
      <span className="progress__fill" style={{ width: `${percent}%` }} />
    </div>
  );
}

/** A horizontal bar for a share between 0 and 1, with its percentage. */
export function ShareBar({ value, label, tone = "accent" }: { value: number; label: string; tone?: "accent" | "success" }) {
  return (
    <span className="share-bar" title={`${label}: ${formatPercent(value)}`}>
      <span className="share-bar__track" aria-hidden="true">
        <span className={clsx("share-bar__fill", `share-bar__fill--${tone}`)} style={{ width: `${Math.min(1, Math.max(0, value)) * 100}%` }} />
      </span>
      <span className="share-bar__value">{formatPercent(value)}</span>
    </span>
  );
}

const jobLabels: Record<JobStatus, string> = {
  queued: "Queued",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};
const jobIcons: Record<JobStatus, LucideIcon> = {
  queued: Clock,
  running: LoaderCircle,
  completed: CircleCheck,
  failed: CircleAlert,
  cancelled: Ban,
};
const jobChipClass: Record<JobStatus, string> = {
  queued: "status-chip--queued",
  running: "status-chip--running",
  completed: "status-chip--ok",
  failed: "status-chip--error",
  cancelled: "status-chip--denied",
};

export const isActiveJob = (status: JobStatus) => status === "queued" || status === "running";

export function JobStatusChip({ status }: { status: JobStatus }) {
  const Icon = jobIcons[status];
  return (
    <span className={clsx("status-chip", jobChipClass[status])}>
      <Icon size={13} aria-hidden="true" className={status === "running" ? "spin" : undefined} />
      {jobLabels[status]}
    </span>
  );
}

type TaskStatus = EvalTaskResult["status"];
const taskLabels: Record<TaskStatus, string> = {
  pending: "Pending",
  running: "Running",
  passed: "Passed",
  failed: "Failed",
  error: "Error",
};
const taskIcons: Record<TaskStatus, LucideIcon> = {
  pending: CircleDashed,
  running: LoaderCircle,
  passed: CircleCheck,
  failed: CircleAlert,
  error: TriangleAlert,
};
const taskChipClass: Record<TaskStatus, string> = {
  pending: "status-chip--queued",
  running: "status-chip--running",
  passed: "status-chip--ok",
  failed: "status-chip--error",
  error: "status-chip--warning",
};

export function TaskStatusChip({ status }: { status: TaskStatus }) {
  const Icon = taskIcons[status];
  return (
    <span className={clsx("status-chip", taskChipClass[status])}>
      <Icon size={13} aria-hidden="true" className={status === "running" ? "spin" : undefined} />
      {taskLabels[status]}
    </span>
  );
}

type ResourceState<T> = { key: string | null; data: T | undefined; error: string | null };

/**
 * Loads data for `key` (refetching when it changes) without setting state synchronously in an effect.
 * `data` keeps the last result while a new key loads, so lists do not flash empty between filters.
 */
export function useResource<T>(key: string, load: () => Promise<T>, failure: string) {
  const [reloads, setReloads] = useState(0);
  const fullKey = `${key}#${reloads}`;
  const [state, setState] = useState<ResourceState<T>>({ key: null, data: undefined, error: null });
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  });

  useEffect(() => {
    let cancelled = false;
    loadRef.current().then(
      (data) => {
        if (!cancelled) setState({ key: fullKey, data, error: null });
      },
      (error: unknown) => {
        if (!cancelled) setState((current) => ({ key: fullKey, data: current.data, error: errorMessage(error, failure) }));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [fullKey, failure]);

  const update = useCallback((change: (data: T) => T) => {
    setState((current) => (current.data === undefined ? current : { ...current, data: change(current.data) }));
  }, []);

  /** Refetches quietly (for polling): keeps showing the current data and ignores failures. */
  const refresh = useCallback(async () => {
    const data = await loadRef.current();
    setState((current) => ({ ...current, data }));
  }, []);

  return {
    data: state.data,
    error: state.key === fullKey ? state.error : null,
    loading: state.key !== fullKey,
    reload: useCallback(() => setReloads((count) => count + 1), []),
    update,
    refresh,
  };
}

/** Calls `poll` every `intervalMs` while `active`, waiting for each call to finish before scheduling the next. */
export function usePolling(active: boolean, poll: () => Promise<unknown>, intervalMs = POLL_INTERVAL_MS) {
  const pollRef = useRef(poll);
  useEffect(() => {
    pollRef.current = poll;
  });
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        await pollRef.current();
      } catch {
        // A failed refresh keeps the last data; the next tick tries again.
      }
      if (!cancelled) timer = setTimeout(() => void tick(), intervalMs);
    };
    timer = setTimeout(() => void tick(), intervalMs);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [active, intervalMs]);
}

export function Alert({ message, onDismiss }: { message: string; onDismiss?: () => void }) {
  return (
    <div className="training-alert" role="alert">
      <CircleAlert size={15} aria-hidden="true" className="training-alert__icon" />
      <span className="training-alert__text">{message}</span>
      {onDismiss && (
        <button type="button" className="icon-button" aria-label="Dismiss" onClick={onDismiss}>
          <X size={14} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

/** Loading, failure with retry, or the content. */
export function Loadable({
  loading,
  error,
  onRetry,
  children,
  what,
}: {
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  children: ReactNode;
  what: string;
}) {
  if (error) {
    return (
      <div className="training-state" role="alert">
        <CircleAlert size={18} aria-hidden="true" />
        <p>{error}</p>
        <button type="button" className="button button--secondary button--small" onClick={onRetry}>
          <RotateCcw size={14} aria-hidden="true" />
          Try again
        </button>
      </div>
    );
  }
  if (loading) {
    return (
      <p className="training-state" aria-live="polite">
        <LoaderCircle size={16} aria-hidden="true" className="spin" />
        Loading {what}…
      </p>
    );
  }
  return <>{children}</>;
}

type ConfirmDialogProps = {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  /** Rejecting keeps the dialog open and shows the error. */
  onConfirm: () => Promise<void>;
  onClose: () => void;
  danger?: boolean;
};

export function ConfirmDialog({ title, children, confirmLabel, onConfirm, onClose, danger = true }: ConfirmDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useDialog(dialogRef, onClose);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
    } catch (caught) {
      setError(errorMessage(caught));
      setBusy(false);
    }
  }

  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div ref={dialogRef} className="dialog dialog--compact" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="dialog__header">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="icon-button" aria-label="Close" onClick={onClose}>
            <X size={18} aria-hidden="true" />
          </button>
        </header>
        <div className="dialog__content">
          {children}
          {error && <Alert message={error} />}
        </div>
        <footer className="dialog__footer">
          <span className="dialog__status" />
          <button type="button" className="button button--ghost" onClick={onClose} data-autofocus>
            Cancel
          </button>
          <button
            type="button"
            className={clsx("button", danger ? "button--danger" : "button--primary")}
            disabled={busy}
            onClick={() => void confirm()}
          >
            {busy ? "Working…" : confirmLabel}
          </button>
        </footer>
      </div>
    </div>
  );
}

/** A titled card that groups one part of a tab. */
export function Panel({
  title,
  description,
  actions,
  children,
  className,
  headingLevel = 2,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  headingLevel?: 2 | 3;
}) {
  const id = useId();
  const Heading = headingLevel === 2 ? "h2" : "h3";
  return (
    <section className={clsx("training-panel", className)} aria-labelledby={id}>
      <div className="training-panel__head">
        <div className="training-panel__titles">
          <Heading id={id} className="training-panel__title">
            {title}
          </Heading>
          {description && <p className="training-panel__description">{description}</p>}
        </div>
        {actions && <div className="training-panel__actions">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

/** Label and value pairs, for stats. */
export function StatGrid({ items }: { items: { label: string; value: ReactNode }[] }) {
  return (
    <dl className="stat-grid">
      {items.map((item) => (
        <div key={item.label} className="stat">
          <dt className="stat__label">{item.label}</dt>
          <dd className="stat__value">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Integer or decimal input that keeps the raw text while typing; `parse` is left to the caller. */
export function NumberField({
  id,
  value,
  onChange,
  step,
  min,
  max,
  invalid,
  describedBy,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  step?: number | "any";
  min?: number;
  max?: number;
  invalid?: boolean;
  describedBy?: string;
}) {
  return (
    <input
      id={id}
      className="field"
      type="number"
      inputMode="decimal"
      value={value}
      step={step}
      min={min}
      max={max}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}
