"use client";

import { Download, FileText, ShieldCheck, Trash2 } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import type { ConversationKind, DatasetExportRequest, DatasetExportView, TrainingStatus } from "@/lib/contract";
import { createExport, deleteExport, errorMessage, exportFileUrl, fetchExports } from "@/lib/client/api";
import { formatBytes, formatTimestamp } from "@/lib/client/format";
import { Segmented, type SegmentedOption } from "../segmented";
import { trainingStatuses, trainingStatusLabels } from "../training-status";
import { Alert, ConfirmDialog, formatCount, formatPercent, humanize, Loadable, Panel, StatGrid, useResource } from "./common";
import { kindLabels } from "./review-tab";

const kinds: ConversationKind[] = ["chat", "eval", "distill"];

const systemPromptOptions: SegmentedOption<DatasetExportRequest["systemPrompt"]>[] = [
  { value: "agent", label: "Agent" },
  { value: "minimal", label: "Minimal" },
];

const systemPromptDescriptions: Record<DatasetExportRequest["systemPrompt"], string> = {
  agent: "Tatvam's full tool-using system prompt, so the model learns to act as this agent.",
  minimal: "A one-line assistant prompt, for a general model that does not depend on Tatvam's tools.",
};

function toggle<T>(list: readonly T[], value: T, on: boolean): T[] {
  return on ? (list.includes(value) ? [...list] : [...list, value]) : list.filter((item) => item !== value);
}

/** One line describing what an export included. */
export function exportSummary(request: DatasetExportRequest): string {
  const parts = [
    request.statuses.map((status) => trainingStatusLabels[status]).join(", "),
    request.kinds.map((kind) => kindLabels[kind]).join(", "),
  ];
  if (request.requirePositiveFeedback) parts.push("positive feedback only");
  if (request.redactPii) parts.push("personal data masked");
  parts.push(`${formatPercent(request.evalFraction)} held out`);
  parts.push(request.systemPrompt === "agent" ? "agent prompt" : "minimal prompt");
  return parts.join(" · ");
}

/** "Export, Oct 10, 12:00" — used for pickers elsewhere. */
export function exportLabel(item: DatasetExportView): string {
  return `${formatTimestamp(item.createdAt)} · ${formatCount(item.stats.sftTrain + item.stats.sftEval, "example")}, ${formatCount(item.stats.preferencePairs, "pair")}`;
}

function Breakdown({ title, counts, empty }: { title: string; counts: Record<string, number>; empty: string }) {
  const entries = Object.entries(counts).filter(([, count]) => count > 0);
  return (
    <div className="breakdown">
      <h4 className="breakdown__title">{title}</h4>
      {entries.length === 0 ? (
        <p className="breakdown__empty">{empty}</p>
      ) : (
        <ul className="breakdown__list">
          {entries.map(([key, count]) => (
            <li key={key} className="breakdown__item">
              <span className="breakdown__key">{humanize(key)}</span>
              <span className="breakdown__count">{count.toLocaleString()}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ExportCard({ item, onDelete }: { item: DatasetExportView; onDelete: () => void }) {
  const titleId = useId();
  const { stats } = item;
  return (
    <article className="training-card" aria-labelledby={titleId}>
      <header className="training-card__head">
        <div className="training-card__titles">
          <h3 id={titleId} className="training-card__title">
            Export from {formatTimestamp(item.createdAt)}
          </h3>
          <p className="training-card__meta">{exportSummary(item.request)}</p>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label={`Delete export from ${formatTimestamp(item.createdAt)}`}
          title="Delete export"
          onClick={onDelete}
        >
          <Trash2 size={15} aria-hidden="true" />
        </button>
      </header>
      <StatGrid
        items={[
          { label: "Conversations", value: stats.conversations.toLocaleString() },
          { label: "Training examples", value: stats.sftTrain.toLocaleString() },
          { label: "Eval examples", value: stats.sftEval.toLocaleString() },
          { label: "Preference pairs", value: stats.preferencePairs.toLocaleString() },
          { label: "Duplicates dropped", value: stats.duplicatesDropped.toLocaleString() },
        ]}
      />
      <div className="breakdowns">
        <Breakdown title="Redactions by kind" counts={stats.redactions} empty="Nothing needed masking." />
        <Breakdown title="Skipped by reason" counts={stats.skipped} empty="No conversations were skipped." />
      </div>
      {item.files.length > 0 && (
        <ul className="file-list" aria-label="Files">
          {item.files.map((file) => (
            <li key={file.name} className="file-list__item">
              <FileText size={15} aria-hidden="true" className="file-list__icon" />
              <span className="file-list__text">
                <span className="file-list__name">{file.name}</span>
                <span className="file-list__meta">
                  {formatBytes(file.bytes)}
                  {file.name.endsWith(".jsonl") ? ` · ${formatCount(file.records, "record")}` : ""}
                </span>
              </span>
              <a
                className="button button--secondary button--small"
                href={exportFileUrl(item.id, file.name)}
                download={file.name}
                aria-label={`Download ${file.name}`}
              >
                <Download size={14} aria-hidden="true" />
                <span className="file-list__download-label">Download</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

/** Builds training datasets from reviewed conversations and lists past exports. */
export function DatasetsTab() {
  const id = useId();
  const exportsResource = useResource("exports", fetchExports, "Exports could not be loaded.");
  const [statuses, setStatuses] = useState<TrainingStatus[]>(["approved"]);
  const [selectedKinds, setSelectedKinds] = useState<ConversationKind[]>(["chat", "distill"]);
  const [requirePositiveFeedback, setRequirePositiveFeedback] = useState(false);
  const [redactPii, setRedactPii] = useState(true);
  const [evalFraction, setEvalFraction] = useState(0.1);
  const [systemPrompt, setSystemPrompt] = useState<DatasetExportRequest["systemPrompt"]>("agent");
  const [submitted, setSubmitted] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<DatasetExportView | null>(null);

  const statusError = submitted && statuses.length === 0 ? "Choose at least one review status." : null;
  const kindError = submitted && selectedKinds.length === 0 ? "Choose at least one kind of conversation." : null;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitted(true);
    setCreated(null);
    if (statuses.length === 0 || selectedKinds.length === 0) return;
    const body: DatasetExportRequest = {
      // Keep the canonical order regardless of click order.
      statuses: trainingStatuses.filter((status) => statuses.includes(status)),
      kinds: kinds.filter((kind) => selectedKinds.includes(kind)),
      requirePositiveFeedback,
      redactPii,
      evalFraction,
      systemPrompt,
    };
    setCreating(true);
    setCreateError(null);
    try {
      const result = await createExport(body);
      exportsResource.update((list) => [result, ...list.filter((item) => item.id !== result.id)]);
      setCreated(`Export created: ${formatCount(result.stats.sftTrain + result.stats.sftEval, "example")}.`);
      setSubmitted(false);
    } catch (error) {
      setCreateError(errorMessage(error, "The dataset could not be exported."));
    } finally {
      setCreating(false);
    }
  }

  const exportsList = exportsResource.data ?? [];

  return (
    <div className="training-stack">
      <Panel
        title="Export a dataset"
        description="Turns reviewed conversations into JSONL for fine-tuning: chat examples for supervised training and, where you wrote corrections, preference pairs."
      >
        <form className="training-form" onSubmit={(event) => void onSubmit(event)} noValidate>
          <div className="training-form__row">
            <fieldset className="checkbox-group" aria-describedby={statusError ? `${id}-status-error` : undefined}>
              <legend className="field-label">Review status</legend>
              {trainingStatuses.map((status) => (
                <label key={status} className="checkbox">
                  <input
                    type="checkbox"
                    checked={statuses.includes(status)}
                    onChange={(event) => setStatuses((current) => toggle(current, status, event.target.checked))}
                  />
                  {trainingStatusLabels[status]}
                </label>
              ))}
              {statusError && (
                <p id={`${id}-status-error`} className="form-field__error">
                  {statusError}
                </p>
              )}
            </fieldset>
            <fieldset className="checkbox-group" aria-describedby={kindError ? `${id}-kind-error` : undefined}>
              <legend className="field-label">Conversations</legend>
              {kinds.map((kind) => (
                <label key={kind} className="checkbox">
                  <input
                    type="checkbox"
                    checked={selectedKinds.includes(kind)}
                    onChange={(event) => setSelectedKinds((current) => toggle(current, kind, event.target.checked))}
                  />
                  {kindLabels[kind]}
                </label>
              ))}
              {kindError && (
                <p id={`${id}-kind-error`} className="form-field__error">
                  {kindError}
                </p>
              )}
            </fieldset>
          </div>
          <div className="checkbox-stack">
            <label className="checkbox checkbox--described">
              <input
                type="checkbox"
                checked={requirePositiveFeedback}
                onChange={(event) => setRequirePositiveFeedback(event.target.checked)}
              />
              <span>
                Require positive feedback
                <span className="checkbox__hint">
                  Only conversations with a thumbs up and no uncorrected thumbs down.
                </span>
              </span>
            </label>
            <label className="checkbox checkbox--described">
              <input type="checkbox" checked={redactPii} onChange={(event) => setRedactPii(event.target.checked)} />
              <span>
                Mask personal data
                <span className="checkbox__hint">Emails, phone numbers and IP addresses.</span>
              </span>
            </label>
          </div>
          <p className="secrets-note">
            <ShieldCheck size={15} aria-hidden="true" />
            <span>Secrets such as API keys, tokens and passwords are always masked, whatever you choose here.</span>
          </p>
          <div className="form-field">
            <label htmlFor={`${id}-eval`} className="field-label">
              Held out for evaluation: <output htmlFor={`${id}-eval`}>{formatPercent(evalFraction)}</output>
            </label>
            <input
              id={`${id}-eval`}
              className="range"
              type="range"
              min={0}
              max={0.5}
              step={0.05}
              value={evalFraction}
              aria-valuetext={formatPercent(evalFraction)}
              aria-describedby={`${id}-eval-hint`}
              onChange={(event) => setEvalFraction(Number(event.target.value))}
            />
            <p id={`${id}-eval-hint`} className="form-field__hint">
              Split by content, so the same example always lands on the same side.
            </p>
          </div>
          <div className="form-field">
            <span className="field-label" id={`${id}-prompt`}>
              System prompt
            </span>
            <Segmented
              label="System prompt"
              value={systemPrompt}
              options={systemPromptOptions}
              onChange={setSystemPrompt}
              describedBy={`${id}-prompt-hint`}
            />
            <p id={`${id}-prompt-hint`} className="form-field__hint">
              {systemPromptDescriptions[systemPrompt]}
            </p>
          </div>
          {createError && <Alert message={createError} onDismiss={() => setCreateError(null)} />}
          <div className="training-form__actions">
            <span className="training-form__status" aria-live="polite">
              {created}
            </span>
            <button type="submit" className="button button--primary" disabled={creating}>
              {creating ? "Exporting…" : "Export dataset"}
            </button>
          </div>
        </form>
      </Panel>
      <Panel title="Exports" description="Each export keeps its files on the server until you delete it.">
        <Loadable
          loading={exportsResource.loading && exportsResource.data === undefined}
          error={exportsResource.error}
          onRetry={exportsResource.reload}
          what="exports"
        >
          {exportsList.length === 0 ? (
            <p className="training-empty">No exports yet.</p>
          ) : (
            <div className="training-cards">
              {exportsList.map((item) => (
                <ExportCard key={item.id} item={item} onDelete={() => setDeleting(item)} />
              ))}
            </div>
          )}
        </Loadable>
      </Panel>
      {deleting && (
        <ConfirmDialog
          title="Delete export"
          confirmLabel="Delete export"
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            await deleteExport(deleting.id);
            exportsResource.update((list) => list.filter((item) => item.id !== deleting.id));
            setDeleting(null);
          }}
        >
          <p className="confirm-text">
            Delete the export from {formatTimestamp(deleting.createdAt)} and its files? This cannot be undone.
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}
