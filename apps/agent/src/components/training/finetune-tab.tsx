"use client";

import { ChevronRight, Download, FileText, FolderOpen } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import {
  type DatasetExportView,
  type FinetuneKitRequest,
  finetuneKitRequestSchema,
  type FinetuneKitView,
} from "@/lib/contract";
import { createKit, errorMessage, fetchExports, fetchKits, kitFileUrl } from "@/lib/client/api";
import { formatBytes, formatTimestamp } from "@/lib/client/format";
import { CopyButton, Markdown } from "../markdown";
import { Segmented, type SegmentedOption } from "../segmented";
import { Alert, Field, Loadable, NumberField, Panel, useResource } from "./common";
import { exportLabel } from "./datasets-tab";

type Method = FinetuneKitRequest["method"];
type Framework = FinetuneKitRequest["framework"];

export const methodLabels: Record<Method, string> = {
  sft_lora: "Supervised fine-tuning, LoRA",
  sft_qlora: "Supervised fine-tuning, QLoRA (4-bit, less memory)",
  dpo_lora: "Preference tuning (DPO), LoRA",
};

const frameworkOptions: SegmentedOption<Framework>[] = [
  { value: "trl", label: "TRL" },
  { value: "axolotl", label: "Axolotl" },
];

/** The form's text values, kept as typed so a half-written number is not lost. */
export type KitForm = {
  exportId: string;
  baseModel: string;
  method: Method;
  framework: Framework;
  epochs: string;
  learningRate: string;
  loraRank: string;
  loraAlpha: string;
  maxSeqLength: string;
  batchSize: string;
  gradientAccumulation: string;
  outputName: string;
};

export type KitField = keyof KitForm;

export const defaultKitForm: KitForm = {
  exportId: "",
  baseModel: "",
  method: "sft_lora",
  framework: "trl",
  epochs: "2",
  learningRate: "2e-4",
  loraRank: "16",
  loraAlpha: "32",
  maxSeqLength: "4096",
  batchSize: "2",
  gradientAccumulation: "8",
  outputName: "tatvam-agent-lora",
};

const BASE_MODEL_PATTERN = /^[\w./:-]+$/;
const OUTPUT_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

type NumberRule = { label: string; min: number; max: number; integer: boolean; minExclusive?: boolean };

const numberRules: Record<
  "epochs" | "learningRate" | "loraRank" | "loraAlpha" | "maxSeqLength" | "batchSize" | "gradientAccumulation",
  NumberRule
> = {
  epochs: { label: "Epochs", min: 0.1, max: 20, integer: false },
  learningRate: { label: "Learning rate", min: 0, max: 0.01, integer: false, minExclusive: true },
  loraRank: { label: "LoRA rank", min: 4, max: 256, integer: true },
  loraAlpha: { label: "LoRA alpha", min: 4, max: 512, integer: true },
  maxSeqLength: { label: "Max sequence length", min: 512, max: 131_072, integer: true },
  batchSize: { label: "Batch size", min: 1, max: 256, integer: true },
  gradientAccumulation: { label: "Gradient accumulation", min: 1, max: 256, integer: true },
};

function checkNumber(raw: string, rule: NumberRule): { value: number } | { error: string } {
  const value = Number(raw.trim());
  const range = rule.minExclusive
    ? `above ${rule.min} and at most ${rule.max.toLocaleString()}`
    : `from ${rule.min.toLocaleString()} to ${rule.max.toLocaleString()}`;
  const message = `${rule.label} must be ${rule.integer ? "a whole number " : ""}${range}.`;
  if (raw.trim() === "" || !Number.isFinite(value)) return { error: message };
  if (rule.integer && !Number.isInteger(value)) return { error: message };
  if (rule.minExclusive ? value <= rule.min : value < rule.min) return { error: message };
  if (value > rule.max) return { error: message };
  return { value };
}

/** Field errors, or the request to send when there are none. */
export function validateKit(
  form: KitForm,
  exports: readonly DatasetExportView[],
): { errors: Partial<Record<KitField, string>>; request: FinetuneKitRequest | null } {
  const errors: Partial<Record<KitField, string>> = {};
  const chosen = exports.find((item) => item.id === form.exportId);
  if (!chosen) errors.exportId = "Choose the dataset export to train on.";
  const baseModel = form.baseModel.trim();
  if (!baseModel) errors.baseModel = "Enter the base model: a Hugging Face repo id or a local path.";
  else if (baseModel.length > 200 || !BASE_MODEL_PATTERN.test(baseModel))
    errors.baseModel = "Use letters, digits and . _ - / : only (up to 200 characters).";
  if (form.method === "dpo_lora" && chosen && chosen.stats.preferencePairs === 0)
    errors.method = "This export has no preference pairs. Write corrections and export again, or choose a supervised method.";
  if (!OUTPUT_NAME_PATTERN.test(form.outputName))
    errors.outputName = "Start with a lowercase letter or digit, then use lowercase letters, digits, . _ or - (up to 64 characters).";

  const numbers: Partial<Record<keyof typeof numberRules, number>> = {};
  for (const [key, rule] of Object.entries(numberRules) as [keyof typeof numberRules, NumberRule][]) {
    const result = checkNumber(form[key], rule);
    if ("error" in result) errors[key] = result.error;
    else numbers[key] = result.value;
  }
  if (Object.keys(errors).length > 0 || !chosen) return { errors, request: null };

  const parsed = finetuneKitRequestSchema.safeParse({
    exportId: chosen.id,
    baseModel,
    method: form.method,
    framework: form.framework,
    hyperparameters: numbers,
    outputName: form.outputName,
  });
  return parsed.success ? { errors, request: parsed.data } : { errors: { outputName: "Check the values and try again." }, request: null };
}

type KitCardProps = {
  kit: FinetuneKitView;
  exportsList: readonly DatasetExportView[];
  /** A kit just created shows its instructions straight away. */
  defaultOpen: boolean;
};

function KitCard({ kit, exportsList, defaultOpen }: KitCardProps) {
  const titleId = useId();
  const instructionsId = useId();
  const [open, setOpen] = useState(defaultOpen);
  const source = exportsList.find((item) => item.id === kit.request.exportId);
  const { hyperparameters: h } = kit.request;
  return (
    <article className="training-card" aria-labelledby={titleId}>
      <header className="training-card__head">
        <div className="training-card__titles">
          <h3 id={titleId} className="training-card__title">
            {kit.request.outputName}
          </h3>
          <p className="training-card__meta">
            {kit.request.baseModel} · {methodLabels[kit.request.method]} · {kit.request.framework === "trl" ? "TRL" : "Axolotl"} ·{" "}
            {formatTimestamp(kit.createdAt)}
          </p>
        </div>
      </header>
      <p className="kit-params">
        {h.epochs} epochs · learning rate {h.learningRate} · LoRA rank {h.loraRank}, alpha {h.loraAlpha} · max length{" "}
        {h.maxSeqLength.toLocaleString()} · batch {h.batchSize} × {h.gradientAccumulation}
        {source ? ` · data: export from ${formatTimestamp(source.createdAt)}` : ""}
      </p>
      <div className="kit-path">
        <FolderOpen size={15} aria-hidden="true" className="kit-path__icon" />
        <code className="kit-path__value">{kit.path}</code>
        <CopyButton text={kit.path} ariaLabel={`Copy the path of ${kit.request.outputName}`} />
      </div>
      {kit.files.length > 0 && (
        <ul className="file-list" aria-label="Files">
          {kit.files.map((file) => (
            <li key={file.name} className="file-list__item">
              <FileText size={15} aria-hidden="true" className="file-list__icon" />
              <span className="file-list__text">
                <span className="file-list__name">{file.name}</span>
                <span className="file-list__meta">{formatBytes(file.bytes)}</span>
              </span>
              <a
                className="button button--secondary button--small"
                href={kitFileUrl(kit.id, file.name)}
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
      {kit.instructions && (
        <div className="kit-instructions-block">
          <button
            type="button"
            className="kit-instructions__toggle"
            aria-expanded={open}
            aria-controls={open ? instructionsId : undefined}
            onClick={() => setOpen(!open)}
          >
            <ChevronRight size={14} aria-hidden="true" className="kit-instructions__chevron" />
            How to run it
          </button>
          {open && (
            <div id={instructionsId} className="kit-instructions">
              <Markdown text={kit.instructions} />
            </div>
          )}
        </div>
      )}
    </article>
  );
}

/** Builds a ready-to-run fine-tuning kit (scripts and config) from a dataset export. */
export function FinetuneTab() {
  const id = useId();
  const exportsResource = useResource("exports", fetchExports, "Exports could not be loaded.");
  const kits = useResource("kits", fetchKits, "Fine-tuning kits could not be loaded.");
  const [form, setForm] = useState<KitForm>(defaultKitForm);
  const [submitted, setSubmitted] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdId, setCreatedId] = useState<string | null>(null);

  const exportsList = exportsResource.data ?? [];
  // The newest export is the natural default until the user picks one.
  const effectiveForm: KitForm = form.exportId || exportsList.length === 0 ? form : { ...form, exportId: exportsList[0].id };
  const { errors, request } = validateKit(effectiveForm, exportsList);
  const shown = (field: KitField) => (submitted ? errors[field] : undefined);
  const set = <K extends KitField>(field: K, value: KitForm[K]) => setForm((current) => ({ ...current, [field]: value }));

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitted(true);
    if (!request) return;
    setCreating(true);
    setError(null);
    try {
      const kit = await createKit(request);
      kits.update((list) => [kit, ...list.filter((item) => item.id !== kit.id)]);
      setCreatedId(kit.id);
      setSubmitted(false);
    } catch (caught) {
      setError(errorMessage(caught, "The kit could not be created."));
    } finally {
      setCreating(false);
    }
  }

  const effectiveBatch = Number(effectiveForm.batchSize) * Number(effectiveForm.gradientAccumulation);

  const numberField = (field: keyof typeof numberRules, step: number | "any", hint?: string) => (
    <Field
      label={numberRules[field].label}
      htmlFor={`${id}-${field}`}
      hint={hint}
      hintId={hint ? `${id}-${field}-hint` : undefined}
      error={shown(field)}
      errorId={`${id}-${field}-error`}
    >
      <NumberField
        id={`${id}-${field}`}
        value={effectiveForm[field]}
        onChange={(value) => set(field, value)}
        step={step}
        invalid={shown(field) !== undefined}
        describedBy={shown(field) ? `${id}-${field}-error` : hint ? `${id}-${field}-hint` : undefined}
      />
    </Field>
  );

  return (
    <div className="training-stack">
      <Panel
        title="Create a fine-tuning kit"
        description="Packs an export with a training script and config for your GPU server. Training runs there, not in Tatvam."
      >
        <Loadable
          loading={exportsResource.loading && exportsResource.data === undefined}
          error={exportsResource.error}
          onRetry={exportsResource.reload}
          what="exports"
        >
          <form className="training-form" onSubmit={(event) => void onSubmit(event)} noValidate>
            <div className="training-form__grid">
              <Field
                label="Dataset export"
                htmlFor={`${id}-export`}
                hint={exportsList.length === 0 ? "Export a dataset on the Datasets tab first." : undefined}
                hintId={`${id}-export-hint`}
                error={shown("exportId")}
                errorId={`${id}-export-error`}
              >
                <select
                  id={`${id}-export`}
                  className="field"
                  value={effectiveForm.exportId}
                  aria-invalid={shown("exportId") !== undefined || undefined}
                  onChange={(event) => set("exportId", event.target.value)}
                >
                  {exportsList.length === 0 && <option value="">No exports yet</option>}
                  {exportsList.map((item) => (
                    <option key={item.id} value={item.id}>
                      {exportLabel(item)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field
                label="Base model"
                htmlFor={`${id}-base`}
                hint="Hugging Face repo id or a path on the GPU server."
                hintId={`${id}-base-hint`}
                error={shown("baseModel")}
                errorId={`${id}-base-error`}
              >
                <input
                  id={`${id}-base`}
                  className="field"
                  value={effectiveForm.baseModel}
                  placeholder="Qwen/Qwen3-8B"
                  spellCheck={false}
                  autoCapitalize="off"
                  aria-invalid={shown("baseModel") !== undefined || undefined}
                  aria-describedby={shown("baseModel") ? `${id}-base-error` : `${id}-base-hint`}
                  onChange={(event) => set("baseModel", event.target.value)}
                />
              </Field>
              <Field label="Method" htmlFor={`${id}-method`} error={shown("method")} errorId={`${id}-method-error`}>
                <select
                  id={`${id}-method`}
                  className="field"
                  value={effectiveForm.method}
                  aria-invalid={shown("method") !== undefined || undefined}
                  aria-describedby={shown("method") ? `${id}-method-error` : undefined}
                  onChange={(event) => set("method", event.target.value as Method)}
                >
                  {(Object.keys(methodLabels) as Method[]).map((method) => (
                    <option key={method} value={method}>
                      {methodLabels[method]}
                    </option>
                  ))}
                </select>
              </Field>
              <div className="form-field">
                <span className="field-label">Framework</span>
                <Segmented
                  label="Framework"
                  value={effectiveForm.framework}
                  options={frameworkOptions}
                  onChange={(value) => set("framework", value)}
                />
              </div>
            </div>
            <fieldset className="hyperparameters">
              <legend className="field-label">Hyperparameters</legend>
              <div className="training-form__grid training-form__grid--dense">
                {numberField("epochs", 0.5)}
                <Field
                  label={numberRules.learningRate.label}
                  htmlFor={`${id}-learningRate`}
                  error={shown("learningRate")}
                  errorId={`${id}-learningRate-error`}
                >
                  <input
                    id={`${id}-learningRate`}
                    className="field"
                    inputMode="decimal"
                    value={effectiveForm.learningRate}
                    spellCheck={false}
                    aria-invalid={shown("learningRate") !== undefined || undefined}
                    aria-describedby={shown("learningRate") ? `${id}-learningRate-error` : undefined}
                    onChange={(event) => set("learningRate", event.target.value)}
                  />
                </Field>
                {numberField("loraRank", 1)}
                {numberField("loraAlpha", 1, "Often twice the rank.")}
                {numberField("maxSeqLength", 512)}
                {numberField("batchSize", 1)}
                {numberField(
                  "gradientAccumulation",
                  1,
                  Number.isFinite(effectiveBatch) && effectiveBatch > 0 ? `Effective batch size: ${effectiveBatch}.` : undefined,
                )}
              </div>
            </fieldset>
            <Field
              label="Output name"
              htmlFor={`${id}-output`}
              hint="Name of the adapter and the merged model."
              hintId={`${id}-output-hint`}
              error={shown("outputName")}
              errorId={`${id}-output-error`}
            >
              <input
                id={`${id}-output`}
                className="field"
                value={effectiveForm.outputName}
                spellCheck={false}
                autoCapitalize="off"
                aria-invalid={shown("outputName") !== undefined || undefined}
                aria-describedby={shown("outputName") ? `${id}-output-error` : `${id}-output-hint`}
                onChange={(event) => set("outputName", event.target.value)}
              />
            </Field>
            {error && <Alert message={error} onDismiss={() => setError(null)} />}
            <div className="training-form__actions">
              <button
                type="button"
                className="button button--ghost"
                onClick={() => {
                  const { epochs, learningRate, loraRank, loraAlpha, maxSeqLength, batchSize, gradientAccumulation } =
                    defaultKitForm;
                  setForm((current) => ({
                    ...current,
                    epochs,
                    learningRate,
                    loraRank,
                    loraAlpha,
                    maxSeqLength,
                    batchSize,
                    gradientAccumulation,
                  }));
                }}
              >
                Reset hyperparameters
              </button>
              <span className="training-form__status" />
              <button type="submit" className="button button--primary" disabled={creating}>
                {creating ? "Creating…" : "Create kit"}
              </button>
            </div>
          </form>
        </Loadable>
      </Panel>
      <Panel title="Kits" description="Copy a kit's folder to the GPU server, or download its files, then follow its instructions.">
        <Loadable loading={kits.loading && kits.data === undefined} error={kits.error} onRetry={kits.reload} what="kits">
          {(kits.data ?? []).length === 0 ? (
            <p className="training-empty">No kits yet.</p>
          ) : (
            <div className="training-cards">
              {(kits.data ?? []).map((kit) => (
                <KitCard key={kit.id} kit={kit} exportsList={exportsList} defaultOpen={kit.id === createdId} />
              ))}
            </div>
          )}
        </Loadable>
      </Panel>
    </div>
  );
}
