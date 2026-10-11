"use client";

import clsx from "clsx";
import { ArrowDownRight, ArrowLeft, ArrowUpRight, ChevronRight, CircleCheck, CircleX, GitCompareArrows, Minus, Square } from "lucide-react";
import Link from "next/link";
import { type FormEvent, Fragment, useId, useState } from "react";
import type { EvalCategory, EvalRunView, EvalSuiteView, EvalTaskResult, ModelRef } from "@/lib/contract";
import { cancelEvalRun, errorMessage, fetchEvalRun, fetchEvalRuns, fetchEvalSuites, startEvalRun } from "@/lib/client/api";
import { formatTimestamp } from "@/lib/client/format";
import {
  Alert,
  type Connections,
  Field,
  formatCount,
  formatDelta,
  formatDuration,
  formatPercent,
  isActiveJob,
  JobStatusChip,
  Loadable,
  ModelSelect,
  modelRefLabel,
  Panel,
  ProgressBar,
  ShareBar,
  StatGrid,
  TaskStatusChip,
  usePolling,
  useResource,
} from "./common";

const categoryLabels: Record<EvalCategory, string> = {
  tool_use: "Tool use",
  coding: "Coding",
  research: "Research",
  instructions: "Instructions",
  safety: "Safety",
};

const finishedTask = (result: EvalTaskResult) =>
  result.status === "passed" || result.status === "failed" || result.status === "error";

export function runProgress(run: EvalRunView): { done: number; total: number } {
  const total = run.summary.total || run.results.length;
  return { done: run.results.filter(finishedTask).length, total };
}

function suiteTitle(suites: readonly EvalSuiteView[], id: string): string {
  return suites.find((suite) => suite.id === id)?.title ?? id;
}

export function runLabel(run: EvalRunView, suites: readonly EvalSuiteView[]): string {
  return `${suiteTitle(suites, run.suiteId)} · ${run.target.model} · ${formatTimestamp(run.startedAt)}`;
}

const conversationUrl = (id: string) => `/c/${encodeURIComponent(id)}`;

/** Runs are cancelled from the list and the detail view alike. */
function useCancel(onDone: (run: EvalRunView) => void) {
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function cancel(run: EvalRunView) {
    setCancelling(run.id);
    setError(null);
    try {
      onDone(await cancelEvalRun(run.id));
    } catch (caught) {
      setError(errorMessage(caught, "The run could not be stopped."));
    } finally {
      setCancelling(null);
    }
  }
  return { cancelling, error, clearError: () => setError(null), cancel };
}

// ── Start a run ─────────────────────────────────────────────────────────────

type StartFormProps = {
  suites: EvalSuiteView[];
  connections: Connections;
  onStarted: (run: EvalRunView) => void;
};

function StartRunForm({ suites, connections, onStarted }: StartFormProps) {
  const id = useId();
  const [chosenSuite, setChosenSuite] = useState<string | null>(null);
  const [target, setTarget] = useState<ModelRef | null>(null);
  const [judge, setJudge] = useState<ModelRef | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const suiteId = chosenSuite ?? suites[0]?.id ?? "";
  const suite = suites.find((item) => item.id === suiteId);
  const targetError = submitted && !target ? "Choose the model to evaluate." : null;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitted(true);
    if (!suite || !target) return;
    setStarting(true);
    setError(null);
    try {
      onStarted(await startEvalRun({ suiteId: suite.id, target, judge }));
      setSubmitted(false);
    } catch (caught) {
      setError(errorMessage(caught, "The evaluation could not be started."));
    } finally {
      setStarting(false);
    }
  }

  return (
    <form className="training-form" onSubmit={(event) => void onSubmit(event)} noValidate>
      <div className="training-form__grid">
        <Field label="Suite" htmlFor={`${id}-suite`} hint={suite?.description} hintId={`${id}-suite-hint`}>
          <select
            id={`${id}-suite`}
            className="field"
            value={suiteId}
            aria-describedby={suite ? `${id}-suite-hint` : undefined}
            onChange={(event) => setChosenSuite(event.target.value)}
          >
            {suites.length === 0 && <option value="">No suites available</option>}
            {suites.map((item) => (
              <option key={item.id} value={item.id}>
                {item.title} ({formatCount(item.tasks.length, "task")})
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Model to evaluate"
          htmlFor={`${id}-target`}
          error={targetError}
          errorId={`${id}-target-error`}
        >
          <ModelSelect
            id={`${id}-target`}
            value={target}
            onChange={setTarget}
            connections={connections}
            invalid={targetError !== null}
            describedBy={targetError ? `${id}-target-error` : undefined}
          />
        </Field>
        <Field
          label="Judge model"
          optional
          htmlFor={`${id}-judge`}
          hint="Grades free-form answers against each task's rubric. Without one, only automatic checks count."
          hintId={`${id}-judge-hint`}
        >
          <ModelSelect
            id={`${id}-judge`}
            value={judge}
            onChange={setJudge}
            connections={connections}
            emptyLabel="No judge (checks only)"
            describedBy={`${id}-judge-hint`}
          />
        </Field>
      </div>
      {error && <Alert message={error} onDismiss={() => setError(null)} />}
      <div className="training-form__actions">
        <span className="training-form__status" />
        <button type="submit" className="button button--primary" disabled={starting || suites.length === 0}>
          {starting ? "Starting…" : "Start run"}
        </button>
      </div>
    </form>
  );
}

// ── Runs list ───────────────────────────────────────────────────────────────

type RunsListProps = {
  runs: EvalRunView[];
  suites: EvalSuiteView[];
  onOpen: (run: EvalRunView) => void;
  onCancelled: (run: EvalRunView) => void;
};

function RunsList({ runs, suites, onOpen, onCancelled }: RunsListProps) {
  const { cancelling, error, clearError, cancel } = useCancel(onCancelled);
  if (runs.length === 0) return <p className="training-empty">No evaluation runs yet.</p>;
  return (
    <>
      {error && <Alert message={error} onDismiss={clearError} />}
      <ul className="run-list">
        {runs.map((run) => {
          const { done, total } = runProgress(run);
          const title = suiteTitle(suites, run.suiteId);
          const active = isActiveJob(run.status);
          return (
            <li key={run.id} className="run-row">
              <div className="run-row__main">
                <button type="button" className="run-row__title" onClick={() => onOpen(run)}>
                  {title}
                  <ChevronRight size={14} aria-hidden="true" />
                </button>
                <p className="run-row__meta">
                  {modelRefLabel(run.target)}
                  {run.judge ? ` · judged by ${run.judge.model}` : ""} · {formatTimestamp(run.startedAt)}
                </p>
              </div>
              <div className="run-row__progress">
                <ProgressBar value={done} total={total} label={`${title} on ${run.target.model}`} />
                <span className="run-row__count">
                  {done}/{total}
                </span>
              </div>
              <div className="run-row__side">
                <span className="run-row__rate" title="Pass rate">
                  <span className="sr-only">Pass rate </span>
                  {formatPercent(run.summary.passRate)}
                </span>
                <JobStatusChip status={run.status} />
                {active && (
                  <button
                    type="button"
                    className="button button--secondary button--small"
                    disabled={cancelling === run.id}
                    aria-label={`Stop ${title} on ${run.target.model}`}
                    onClick={() => void cancel(run)}
                  >
                    <Square size={12} aria-hidden="true" />
                    Stop
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}

// ── Run detail ──────────────────────────────────────────────────────────────

function ChecksRow({ result, id, columns }: { result: EvalTaskResult; id: string; columns: number }) {
  return (
    <tr id={id} className="results-table__checks">
      <td colSpan={columns}>
        {result.checks.length === 0 ? (
          <p className="training-empty">No checks recorded.</p>
        ) : (
          <ul className="check-list">
            {result.checks.map((check, index) => (
              <li key={`${check.name}-${index}`} className={clsx("check", check.passed ? "check--passed" : "check--failed")}>
                {check.passed ? (
                  <CircleCheck size={14} aria-hidden="true" className="check__icon" />
                ) : (
                  <CircleX size={14} aria-hidden="true" className="check__icon" />
                )}
                <span className="check__text">
                  <span className="check__name">
                    <span className="sr-only">{check.passed ? "Passed: " : "Failed: "}</span>
                    {check.name}
                  </span>
                  {check.detail && <span className="check__detail">{check.detail}</span>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </td>
    </tr>
  );
}

function ResultsTable({ results }: { results: EvalTaskResult[] }) {
  const baseId = useId();
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const columns = 8;
  const toggle = (taskId: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });

  return (
    <div className="table-wrap">
      <table className="results-table">
        <caption className="sr-only">Results per task</caption>
        <thead>
          <tr>
            <th scope="col">Task</th>
            <th scope="col">Status</th>
            <th scope="col" className="num">Score</th>
            <th scope="col" className="num">Steps</th>
            <th scope="col" className="num">Duration</th>
            <th scope="col" className="num">Tool calls</th>
            <th scope="col" className="num">Invalid</th>
            <th scope="col">
              <span className="sr-only">Conversation</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {results.map((result) => {
            const expanded = open.has(result.taskId);
            const checksId = `${baseId}-${result.taskId}`;
            const passedChecks = result.checks.filter((check) => check.passed).length;
            return (
              <Fragment key={result.taskId}>
                <tr className={clsx(`results-table__row--${result.status}`)}>
                  <th scope="row" className="results-table__task">
                    <span className="results-table__title">{result.title}</span>
                    <span className="results-table__category">{categoryLabels[result.category]}</span>
                    {result.checks.length > 0 && (
                      <button
                        type="button"
                        className="checks-toggle"
                        aria-expanded={expanded}
                        aria-controls={expanded ? checksId : undefined}
                        aria-label={`Checks for ${result.title}: ${passedChecks} of ${result.checks.length} passed`}
                        onClick={() => toggle(result.taskId)}
                      >
                        <ChevronRight size={13} aria-hidden="true" className="checks-toggle__chevron" />
                        Checks {passedChecks}/{result.checks.length}
                      </button>
                    )}
                  </th>
                  <td>
                    <TaskStatusChip status={result.status} />
                  </td>
                  <td className="num">{formatPercent(result.score)}</td>
                  <td className="num">{result.steps}</td>
                  <td className="num">{formatDuration(result.durationMs)}</td>
                  <td className="num">{result.toolCalls}</td>
                  <td className={clsx("num", result.invalidToolCalls > 0 && "num--bad")}>{result.invalidToolCalls}</td>
                  <td>
                    {result.conversationId && (
                      <Link
                        href={conversationUrl(result.conversationId)}
                        className="table-link"
                        aria-label={`Open the conversation for ${result.title}`}
                      >
                        Conversation
                      </Link>
                    )}
                  </td>
                </tr>
                {expanded && <ChecksRow result={result} id={checksId} columns={columns} />}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

type RunDetailProps = {
  runId: string;
  initial: EvalRunView | undefined;
  suites: EvalSuiteView[];
  onBack: () => void;
  onChanged: (run: EvalRunView) => void;
};

function RunDetail({ runId, initial, suites, onBack, onChanged }: RunDetailProps) {
  const detail = useResource(`run/${runId}`, () => fetchEvalRun(runId), "This run could not be loaded.");
  const run = detail.data ?? initial;
  const active = run !== undefined && isActiveJob(run.status);
  const { cancelling, error, clearError, cancel } = useCancel((updated) => {
    detail.update(() => updated);
    onChanged(updated);
  });

  usePolling(active, async () => {
    await detail.refresh();
  });

  const title = run ? `${suiteTitle(suites, run.suiteId)} on ${run.target.model}` : "Evaluation run";
  return (
    <Panel
      title={title}
      description={run ? `Started ${formatTimestamp(run.startedAt)}${run.finishedAt ? `, finished ${formatTimestamp(run.finishedAt)}` : ""}` : undefined}
      actions={
        <>
          <button type="button" className="button button--ghost button--small" onClick={onBack}>
            <ArrowLeft size={14} aria-hidden="true" />
            All runs
          </button>
          {run && active && (
            <button
              type="button"
              className="button button--secondary button--small"
              disabled={cancelling === run.id}
              onClick={() => void cancel(run)}
            >
              <Square size={12} aria-hidden="true" />
              Stop run
            </button>
          )}
        </>
      }
    >
      <Loadable loading={run === undefined && detail.loading} error={run ? null : detail.error} onRetry={detail.reload} what="the run">
        {run && (
          <div className="run-detail">
            <div className="run-detail__meta">
              <JobStatusChip status={run.status} />
              <span>Model: {modelRefLabel(run.target)}</span>
              <span>Judge: {run.judge ? modelRefLabel(run.judge) : "none"}</span>
            </div>
            {run.error && <Alert message={run.error} />}
            {error && <Alert message={error} onDismiss={clearError} />}
            {active && (
              <ProgressBar value={runProgress(run).done} total={runProgress(run).total} label="Run progress" />
            )}
            <StatGrid
              items={[
                { label: "Pass rate", value: formatPercent(run.summary.passRate) },
                { label: "Passed", value: run.summary.passed },
                { label: "Failed", value: run.summary.failed },
                { label: "Errors", value: run.summary.errors },
                { label: "Valid tool calls", value: formatPercent(run.summary.toolCallValidity) },
                { label: "Average steps", value: run.summary.avgSteps.toFixed(1) },
                { label: "Average duration", value: formatDuration(run.summary.avgDurationMs) },
              ]}
            />
            {Object.keys(run.summary.byCategory).length > 0 && (
              <ul className="category-list" aria-label="Pass rate by category">
                {(Object.entries(run.summary.byCategory) as [EvalCategory, { total: number; passed: number }][]).map(
                  ([category, counts]) => (
                    <li key={category} className="category-list__item">
                      <span className="category-list__label">{categoryLabels[category]}</span>
                      <span className="category-list__count">
                        {counts.passed}/{counts.total}
                      </span>
                      <ShareBar
                        value={counts.total > 0 ? counts.passed / counts.total : 0}
                        label={categoryLabels[category]}
                        tone="success"
                      />
                    </li>
                  ),
                )}
              </ul>
            )}
            <ResultsTable results={run.results} />
          </div>
        )}
      </Loadable>
    </Panel>
  );
}

// ── Compare ─────────────────────────────────────────────────────────────────

type Change = "regression" | "improvement" | "same" | "missing";

const passed = (result: EvalTaskResult | undefined) => result?.status === "passed";
const failedOrError = (result: EvalTaskResult | undefined) => result?.status === "failed" || result?.status === "error";

export function compareResults(baseline: EvalRunView, candidate: EvalRunView) {
  const order = [
    ...baseline.results.map((result) => result.taskId),
    ...candidate.results.map((result) => result.taskId).filter((taskId) => !baseline.results.some((r) => r.taskId === taskId)),
  ];
  return order.map((taskId) => {
    const before = baseline.results.find((result) => result.taskId === taskId);
    const after = candidate.results.find((result) => result.taskId === taskId);
    const change: Change =
      !before || !after
        ? "missing"
        : passed(before) && failedOrError(after)
          ? "regression"
          : failedOrError(before) && passed(after)
            ? "improvement"
            : "same";
    return { taskId, title: before?.title ?? after?.title ?? taskId, before, after, change };
  });
}

const changeLabels: Record<Change, string> = {
  regression: "Regression",
  improvement: "Improvement",
  same: "No change",
  missing: "Not in both runs",
};

function CompareView({ runs, suites, onBack }: { runs: EvalRunView[]; suites: EvalSuiteView[]; onBack: () => void }) {
  const id = useId();
  const [baselineId, setBaselineId] = useState("");
  const [candidateId, setCandidateId] = useState("");
  const baseline = runs.find((run) => run.id === baselineId);
  const candidates = baseline ? runs.filter((run) => run.suiteId === baseline.suiteId && run.id !== baseline.id) : [];
  const candidate = candidates.find((run) => run.id === candidateId);
  const rows = baseline && candidate ? compareResults(baseline, candidate) : [];
  const regressions = rows.filter((row) => row.change === "regression").length;
  const improvements = rows.filter((row) => row.change === "improvement").length;
  const delta = baseline && candidate ? (candidate.summary.passRate - baseline.summary.passRate) * 100 : 0;

  return (
    <Panel
      title="Compare runs"
      description="Pick two runs of the same suite, for example a base model and its fine-tune."
      actions={
        <button type="button" className="button button--ghost button--small" onClick={onBack}>
          <ArrowLeft size={14} aria-hidden="true" />
          All runs
        </button>
      }
    >
      <div className="training-form__grid">
        <Field label="Baseline run" htmlFor={`${id}-baseline`}>
          <select
            id={`${id}-baseline`}
            className="field"
            value={baselineId}
            onChange={(event) => {
              setBaselineId(event.target.value);
              setCandidateId("");
            }}
          >
            <option value="" disabled>
              Choose a run
            </option>
            {runs.map((run) => (
              <option key={run.id} value={run.id}>
                {runLabel(run, suites)}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Candidate run"
          htmlFor={`${id}-candidate`}
          hint={baseline && candidates.length === 0 ? "No other run of this suite yet." : undefined}
        >
          <select
            id={`${id}-candidate`}
            className="field"
            value={candidateId}
            disabled={!baseline || candidates.length === 0}
            onChange={(event) => setCandidateId(event.target.value)}
          >
            <option value="" disabled>
              {baseline ? "Choose a run" : "Choose the baseline first"}
            </option>
            {candidates.map((run) => (
              <option key={run.id} value={run.id}>
                {runLabel(run, suites)}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {baseline && candidate && (
        <div className="compare">
          <div className="compare__summary">
            <StatGrid
              items={[
                { label: "Baseline pass rate", value: formatPercent(baseline.summary.passRate) },
                { label: "Candidate pass rate", value: formatPercent(candidate.summary.passRate) },
                {
                  label: "Change",
                  value: (
                    <span className={clsx("delta", delta > 0 && "delta--up", delta < 0 && "delta--down")}>
                      {delta > 0 ? (
                        <ArrowUpRight size={15} aria-hidden="true" />
                      ) : delta < 0 ? (
                        <ArrowDownRight size={15} aria-hidden="true" />
                      ) : (
                        <Minus size={15} aria-hidden="true" />
                      )}
                      {formatDelta(delta)}
                    </span>
                  ),
                },
                { label: "Regressions", value: regressions },
                { label: "Improvements", value: improvements },
              ]}
            />
          </div>
          <div className="table-wrap">
            <table className="results-table compare-table">
              <caption className="sr-only">Results per task, baseline and candidate</caption>
              <thead>
                <tr>
                  <th scope="col">Task</th>
                  <th scope="col">Baseline · {baseline.target.model}</th>
                  <th scope="col">Candidate · {candidate.target.model}</th>
                  <th scope="col">Change</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.taskId} className={clsx("compare-row", `compare-row--${row.change}`)}>
                    <th scope="row">{row.title}</th>
                    <td>{row.before ? <TaskStatusChip status={row.before.status} /> : "—"}</td>
                    <td>{row.after ? <TaskStatusChip status={row.after.status} /> : "—"}</td>
                    <td className="compare-row__change">{changeLabels[row.change]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Panel>
  );
}

// ── Tab ─────────────────────────────────────────────────────────────────────

type View = { type: "list" } | { type: "run"; id: string } | { type: "compare" };

/** Runs evaluation suites against models, shows per-task results and compares runs. */
export function EvalsTab({ connections }: { connections: Connections }) {
  const suites = useResource("suites", fetchEvalSuites, "Evaluation suites could not be loaded.");
  const runs = useResource("runs", fetchEvalRuns, "Evaluation runs could not be loaded.");
  const [view, setView] = useState<View>({ type: "list" });
  const suiteList = suites.data ?? [];
  const runList = runs.data ?? [];
  const anyActive = runList.some((run) => isActiveJob(run.status));

  usePolling(anyActive && view.type !== "run", runs.refresh);

  const replaceRun = (updated: EvalRunView) =>
    runs.update((list) => list.map((run) => (run.id === updated.id ? updated : run)));

  /** Back to the list, refreshed: runs may have finished while the detail or comparison was open. */
  const showList = () => {
    setView({ type: "list" });
    runs.refresh().catch(() => {
      // The list keeps its last data; polling or the next visit catches up.
    });
  };

  if (view.type === "run") {
    return (
      <div className="training-stack">
        <RunDetail
          key={view.id}
          runId={view.id}
          initial={runList.find((run) => run.id === view.id)}
          suites={suiteList}
          onBack={showList}
          onChanged={replaceRun}
        />
      </div>
    );
  }

  if (view.type === "compare") {
    return (
      <div className="training-stack">
        <CompareView runs={runList} suites={suiteList} onBack={showList} />
      </div>
    );
  }

  return (
    <div className="training-stack">
      <Panel
        title="Start a run"
        description="Runs every task of a suite in a throwaway workspace and scores the results."
      >
        <Loadable loading={suites.loading && suites.data === undefined} error={suites.error} onRetry={suites.reload} what="suites">
          <StartRunForm
            suites={suiteList}
            connections={connections}
            onStarted={(run) => runs.update((list) => [run, ...list.filter((item) => item.id !== run.id)])}
          />
        </Loadable>
      </Panel>
      <Panel
        title="Runs"
        description={anyActive ? "Refreshing every 2 seconds while runs are in progress." : undefined}
        actions={
          <button
            type="button"
            className="button button--secondary button--small"
            disabled={runList.length < 2}
            onClick={() => setView({ type: "compare" })}
          >
            <GitCompareArrows size={14} aria-hidden="true" />
            Compare runs
          </button>
        }
      >
        <Loadable loading={runs.loading && runs.data === undefined} error={runs.error} onRetry={runs.reload} what="runs">
          <RunsList
            runs={runList}
            suites={suiteList}
            onOpen={(run) => setView({ type: "run", id: run.id })}
            onCancelled={replaceRun}
          />
        </Loadable>
      </Panel>
    </div>
  );
}
