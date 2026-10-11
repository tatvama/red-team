"use client";

import { Square } from "lucide-react";
import Link from "next/link";
import { type FormEvent, useId, useState } from "react";
import type { DistillJobView, DistillRequest, ModelRef } from "@/lib/contract";
import { cancelDistill, errorMessage, fetchDistillJobs, startDistill } from "@/lib/client/api";
import { formatTimestamp } from "@/lib/client/format";
import { Switch } from "../mcp-servers";
import { Segmented, type SegmentedOption } from "../segmented";
import {
  Alert,
  type Connections,
  Field,
  formatCount,
  isActiveJob,
  JobStatusChip,
  Loadable,
  ModelSelect,
  modelRefLabel,
  NumberField,
  Panel,
  ProgressBar,
  usePolling,
  useResource,
} from "./common";

type SourceType = DistillRequest["source"]["type"];

const sourceOptions: SegmentedOption<SourceType>[] = [
  { value: "prompts", label: "Prompts" },
  { value: "history", label: "Recent conversations" },
];

const MAX_PROMPTS = 200;
const MAX_PROMPT_CHARS = 8000;
const MAX_HISTORY = 500;
const SHOWN_CONVERSATIONS = 8;

const conversationUrl = (id: string) => `/c/${encodeURIComponent(id)}`;

/** One prompt per non-empty line. */
export function parsePrompts(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function JobConversations({ ids }: { ids: string[] }) {
  const [showAll, setShowAll] = useState(false);
  if (ids.length === 0) return null;
  const shown = showAll ? ids : ids.slice(0, SHOWN_CONVERSATIONS);
  return (
    <div className="job-conversations">
      <span className="job-conversations__label">Created conversations</span>
      <ul className="job-conversations__list">
        {shown.map((id, index) => (
          <li key={id}>
            <Link href={conversationUrl(id)} className="table-link">
              Conversation {index + 1}
            </Link>
          </li>
        ))}
      </ul>
      {ids.length > SHOWN_CONVERSATIONS && (
        <button type="button" className="link-button job-conversations__more" onClick={() => setShowAll(!showAll)}>
          {showAll ? "Show fewer" : `Show all ${ids.length}`}
        </button>
      )}
    </div>
  );
}

/** Distillation: a strong teacher model answers prompts, and its conversations become training data. */
export function DistillTab({ connections }: { connections: Connections }) {
  const id = useId();
  const jobs = useResource("distill", fetchDistillJobs, "Distillation jobs could not be loaded.");
  const [teacher, setTeacher] = useState<ModelRef | null>(null);
  const [source, setSource] = useState<SourceType>("prompts");
  const [promptsText, setPromptsText] = useState("");
  const [historyLimit, setHistoryLimit] = useState("50");
  const [autoApprove, setAutoApprove] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);

  const jobList = jobs.data ?? [];
  const anyActive = jobList.some((job) => isActiveJob(job.status));
  usePolling(anyActive, jobs.refresh);

  const prompts = parsePrompts(promptsText);
  const limit = Number(historyLimit);
  const teacherError = submitted && !teacher ? "Choose a teacher model." : null;
  let sourceProblem: string | null = null;
  if (source === "prompts") {
    if (prompts.length === 0) sourceProblem = "Enter at least one prompt, one per line.";
    else if (prompts.length > MAX_PROMPTS) sourceProblem = `Use at most ${MAX_PROMPTS} prompts per job.`;
    else if (prompts.some((prompt) => prompt.length > MAX_PROMPT_CHARS))
      sourceProblem = `Each prompt can be at most ${MAX_PROMPT_CHARS.toLocaleString()} characters.`;
  } else if (!Number.isInteger(limit) || limit < 1 || limit > MAX_HISTORY) {
    sourceProblem = `Enter a whole number from 1 to ${MAX_HISTORY}.`;
  }
  // An empty prompt list is only an error once the form is sent; other problems show while typing.
  const sourceError = sourceProblem && (submitted || source === "history" || prompts.length > 0) ? sourceProblem : null;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitted(true);
    if (!teacher || sourceProblem) return;
    const body: DistillRequest = {
      teacher,
      source: source === "prompts" ? { type: "prompts", prompts } : { type: "history", limit },
      autoApprove,
    };
    setStarting(true);
    setError(null);
    try {
      const job = await startDistill(body);
      jobs.update((list) => [job, ...list.filter((item) => item.id !== job.id)]);
      setSubmitted(false);
      if (source === "prompts") setPromptsText("");
    } catch (caught) {
      setError(errorMessage(caught, "The distillation job could not be started."));
    } finally {
      setStarting(false);
    }
  }

  async function cancel(job: DistillJobView) {
    setCancelling(job.id);
    setCancelError(null);
    try {
      const updated = await cancelDistill(job.id);
      jobs.update((list) => list.map((item) => (item.id === updated.id ? updated : item)));
    } catch (caught) {
      setCancelError(errorMessage(caught, "The job could not be stopped."));
    } finally {
      setCancelling(null);
    }
  }

  const sourceErrorId = `${id}-source-error`;

  return (
    <div className="training-stack">
      <Panel
        title="Distill from a teacher"
        description="A stronger model answers your prompts with the same tools Tatvam uses. Its conversations join the review queue as training data for a smaller model."
      >
        <form className="training-form" onSubmit={(event) => void onSubmit(event)} noValidate>
          <Field label="Teacher model" htmlFor={`${id}-teacher`} error={teacherError} errorId={`${id}-teacher-error`}>
            <ModelSelect
              id={`${id}-teacher`}
              value={teacher}
              onChange={setTeacher}
              connections={connections}
              invalid={teacherError !== null}
              describedBy={teacherError ? `${id}-teacher-error` : undefined}
            />
          </Field>
          <div className="form-field">
            <span className="field-label">Source</span>
            <Segmented label="Source" value={source} options={sourceOptions} onChange={setSource} />
          </div>
          {source === "prompts" ? (
            <Field
              label="Prompts"
              htmlFor={`${id}-prompts`}
              hint={`One prompt per line · ${formatCount(prompts.length, "prompt")}`}
              hintId={`${id}-prompts-hint`}
              error={sourceError}
              errorId={sourceErrorId}
            >
              <textarea
                id={`${id}-prompts`}
                className="field field--textarea"
                rows={6}
                value={promptsText}
                placeholder={"Add a --dry-run flag to the CLI\nExplain how the parser handles escapes"}
                aria-invalid={sourceError !== null || undefined}
                aria-describedby={`${id}-prompts-hint${sourceError ? ` ${sourceErrorId}` : ""}`}
                onChange={(event) => setPromptsText(event.target.value)}
              />
            </Field>
          ) : (
            <Field
              label="Number of recent conversations"
              htmlFor={`${id}-history`}
              hint="Re-asks the first message of your most recent chat conversations."
              hintId={`${id}-history-hint`}
              error={sourceError}
              errorId={sourceErrorId}
            >
              <NumberField
                id={`${id}-history`}
                value={historyLimit}
                onChange={setHistoryLimit}
                step={1}
                min={1}
                max={MAX_HISTORY}
                invalid={sourceError !== null}
                describedBy={`${id}-history-hint${sourceError ? ` ${sourceErrorId}` : ""}`}
              />
            </Field>
          )}
          <div className="switch-row">
            <Switch checked={autoApprove} label="Approve automatically" onChange={setAutoApprove} />
            <span className="switch-row__text">
              <span className="switch-row__label" aria-hidden="true">
                Approve automatically
              </span>
              <span className="switch-row__hint">
                Marks the teacher&apos;s conversations approved for training. Leave off to review them first.
              </span>
            </span>
          </div>
          {error && <Alert message={error} onDismiss={() => setError(null)} />}
          <div className="training-form__actions">
            <span className="training-form__status" />
            <button type="submit" className="button button--primary" disabled={starting}>
              {starting ? "Starting…" : "Start distillation"}
            </button>
          </div>
        </form>
      </Panel>
      <Panel
        title="Jobs"
        description={anyActive ? "Refreshing every 2 seconds while jobs are in progress." : undefined}
      >
        <Loadable loading={jobs.loading && jobs.data === undefined} error={jobs.error} onRetry={jobs.reload} what="jobs">
          {cancelError && <Alert message={cancelError} onDismiss={() => setCancelError(null)} />}
          {jobList.length === 0 ? (
            <p className="training-empty">No distillation jobs yet.</p>
          ) : (
            <ul className="run-list">
              {jobList.map((job) => {
                const done = job.completed + job.failed;
                return (
                  <li key={job.id} className="run-row run-row--job">
                    <div className="run-row__main">
                      <span className="run-row__heading">Teacher: {modelRefLabel(job.teacher)}</span>
                      <p className="run-row__meta">
                        Started {formatTimestamp(job.startedAt)}
                        {job.failed > 0 ? ` · ${formatCount(job.failed, "prompt")} failed` : ""}
                      </p>
                    </div>
                    <div className="run-row__progress">
                      <ProgressBar value={done} total={job.total} label={`Distillation with ${job.teacher.model}`} />
                      <span className="run-row__count">
                        {done}/{job.total}
                      </span>
                    </div>
                    <div className="run-row__side">
                      <JobStatusChip status={job.status} />
                      {isActiveJob(job.status) && (
                        <button
                          type="button"
                          className="button button--secondary button--small"
                          disabled={cancelling === job.id}
                          aria-label={`Stop distillation with ${job.teacher.model}`}
                          onClick={() => void cancel(job)}
                        >
                          <Square size={12} aria-hidden="true" />
                          Stop
                        </button>
                      )}
                    </div>
                    {job.error && (
                      <div className="run-row__wide">
                        <Alert message={job.error} />
                      </div>
                    )}
                    <div className="run-row__wide">
                      <JobConversations ids={job.conversationIds} />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Loadable>
      </Panel>
    </div>
  );
}
