"use client";

import { ArrowUpCircle, Archive, Check, NotebookPen, Trash2, X } from "lucide-react";
import { type FormEvent, useId, useRef, useState } from "react";
import { type ModelRef, providerNames, type RegisteredModel, type RouterConfig } from "@/lib/contract";
import {
  ApiError,
  deleteModel,
  errorMessage,
  fetchExports,
  fetchRegistry,
  fetchRouterConfig,
  registerModel,
  type RegisterModelRequest,
  saveRouterConfig,
  updateModel,
} from "@/lib/client/api";
import { formatTimestamp } from "@/lib/client/format";
import { Switch } from "../mcp-servers";
import { useDialog } from "../use-dialog";
import {
  Alert,
  ConfirmDialog,
  type Connections,
  Field,
  formatPercent,
  Loadable,
  ModelSelect,
  modelRefLabel,
  NumberField,
  Panel,
  sameModel,
  useResource,
} from "./common";
import { exportLabel } from "./datasets-tab";

type ModelKind = RegisteredModel["kind"];
type ModelStatus = RegisteredModel["status"];

const kindLabels: Record<ModelKind, string> = { base: "Base", finetune: "Fine-tune", distilled: "Distilled" };
const statusLabels: Record<ModelStatus, string> = { candidate: "Candidate", active: "Active", retired: "Retired" };
const statusChips: Record<ModelStatus, string> = {
  candidate: "status-chip--queued",
  active: "status-chip--ok",
  retired: "status-chip--denied",
};

function ModelStatusChip({ status }: { status: ModelStatus }) {
  return <span className={`status-chip ${statusChips[status]}`}>{statusLabels[status]}</span>;
}

// ── Registry ────────────────────────────────────────────────────────────────

type RegisterFormProps = {
  connections: Connections;
  models: RegisteredModel[];
  onRegistered: (model: RegisteredModel) => void;
};

function RegisterForm({ connections, models, onRegistered }: RegisterFormProps) {
  const id = useId();
  const exportsResource = useResource("exports", fetchExports, "Exports could not be loaded.");
  const [model, setModel] = useState<ModelRef | null>(null);
  const [label, setLabel] = useState("");
  const [kind, setKind] = useState<ModelKind>("base");
  const [parentId, setParentId] = useState("");
  const [datasetExportId, setDatasetExportId] = useState("");
  const [notes, setNotes] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const modelError = submitted && !model ? "Choose the model to register." : null;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitted(true);
    if (!model) return;
    const body: RegisterModelRequest = {
      provider: model.provider,
      modelId: model.model,
      label: (label.trim() || model.model).slice(0, 120),
      kind,
      parentId: kind !== "base" && parentId ? parentId : null,
      datasetExportId: kind !== "base" && datasetExportId ? datasetExportId : null,
      status: "candidate",
      notes: notes.trim(),
    };
    setSaving(true);
    setError(null);
    try {
      onRegistered(await registerModel(body));
      setModel(null);
      setLabel("");
      setNotes("");
      setParentId("");
      setDatasetExportId("");
      setSubmitted(false);
    } catch (caught) {
      setError(
        caught instanceof ApiError && caught.status === 409
          ? `${model.model} on ${providerNames[model.provider]} is already registered. Change it in the registry instead.`
          : errorMessage(caught, "The model could not be registered."),
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="training-form" onSubmit={(event) => void onSubmit(event)} noValidate>
      <div className="training-form__grid">
        <Field label="Model" htmlFor={`${id}-model`} error={modelError} errorId={`${id}-model-error`}>
          <ModelSelect
            id={`${id}-model`}
            value={model}
            onChange={setModel}
            connections={connections}
            invalid={modelError !== null}
            describedBy={modelError ? `${id}-model-error` : undefined}
          />
        </Field>
        <Field label="Label" optional htmlFor={`${id}-label`} hint="Defaults to the model id." hintId={`${id}-label-hint`}>
          <input
            id={`${id}-label`}
            className="field"
            value={label}
            maxLength={120}
            placeholder={model?.model ?? "Qwen3 coder, fine-tune 2"}
            aria-describedby={`${id}-label-hint`}
            onChange={(event) => setLabel(event.target.value)}
          />
        </Field>
        <Field label="Kind" htmlFor={`${id}-kind`}>
          <select id={`${id}-kind`} className="field" value={kind} onChange={(event) => setKind(event.target.value as ModelKind)}>
            {(Object.keys(kindLabels) as ModelKind[]).map((value) => (
              <option key={value} value={value}>
                {kindLabels[value]}
              </option>
            ))}
          </select>
        </Field>
        {kind !== "base" && (
          <>
            <Field label="Trained from" optional htmlFor={`${id}-parent`}>
              <select id={`${id}-parent`} className="field" value={parentId} onChange={(event) => setParentId(event.target.value)}>
                <option value="">Not recorded</option>
                {models.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Dataset export" optional htmlFor={`${id}-export`}>
              <select
                id={`${id}-export`}
                className="field"
                value={datasetExportId}
                onChange={(event) => setDatasetExportId(event.target.value)}
              >
                <option value="">Not recorded</option>
                {(exportsResource.data ?? []).map((item) => (
                  <option key={item.id} value={item.id}>
                    {exportLabel(item)}
                  </option>
                ))}
              </select>
            </Field>
          </>
        )}
      </div>
      <Field label="Notes" optional htmlFor={`${id}-notes`}>
        <textarea
          id={`${id}-notes`}
          className="field field--textarea"
          rows={2}
          maxLength={4000}
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
        />
      </Field>
      {error && <Alert message={error} onDismiss={() => setError(null)} />}
      <div className="training-form__actions">
        <span className="training-form__status">New models start as candidates.</span>
        <button type="submit" className="button button--primary" disabled={saving}>
          {saving ? "Registering…" : "Register model"}
        </button>
      </div>
    </form>
  );
}

type StatusChange = { model: RegisteredModel; mode: "active" | "retired" | "notes" };

const changeCopy: Record<StatusChange["mode"], { title: string; confirm: string; intro: string }> = {
  active: {
    title: "Promote to active",
    confirm: "Promote",
    intro: "Marks this model as one you use. The router is configured separately below.",
  },
  retired: {
    title: "Retire model",
    confirm: "Retire",
    intro: "Keeps the model and its history in the registry but marks it as no longer used.",
  },
  notes: { title: "Edit notes", confirm: "Save notes", intro: "Notes are for you: why a model was promoted, what it is good at." },
};

function StatusDialog({
  change,
  onClose,
  onSaved,
}: {
  change: StatusChange;
  onClose: () => void;
  onSaved: (model: RegisteredModel) => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const notesId = useId();
  const [notes, setNotes] = useState(change.model.notes);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const copy = changeCopy[change.mode];
  useDialog(dialogRef, onClose, "textarea");

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const body = change.mode === "notes" ? { notes } : { status: change.mode, notes };
      onSaved(await updateModel(change.model.id, body));
    } catch (caught) {
      setError(errorMessage(caught, "The model could not be updated."));
      setSaving(false);
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
          <h2 id={titleId}>
            {copy.title}: {change.model.label}
          </h2>
          <button type="button" className="icon-button" aria-label="Close" onClick={onClose}>
            <X size={18} aria-hidden="true" />
          </button>
        </header>
        <div className="dialog__content">
          <p className="confirm-text">{copy.intro}</p>
          <label htmlFor={notesId} className="field-label">
            Notes
          </label>
          <textarea
            id={notesId}
            className="field field--textarea"
            rows={4}
            maxLength={4000}
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
          />
          {error && <Alert message={error} />}
        </div>
        <footer className="dialog__footer">
          <span className="dialog__status" />
          <button type="button" className="button button--ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="button button--primary" disabled={saving} onClick={() => void save()}>
            {saving ? "Saving…" : copy.confirm}
          </button>
        </footer>
      </div>
    </div>
  );
}

function RegistryTable({
  models,
  onChange,
  onDelete,
}: {
  models: RegisteredModel[];
  onChange: (change: StatusChange) => void;
  onDelete: (model: RegisteredModel) => void;
}) {
  if (models.length === 0) return <p className="training-empty">No models registered yet.</p>;
  return (
    <div className="table-wrap">
      <table className="results-table registry-table">
        <caption className="sr-only">Registered models</caption>
        <thead>
          <tr>
            <th scope="col">Model</th>
            <th scope="col">Kind</th>
            <th scope="col">Status</th>
            <th scope="col">Latest eval</th>
            <th scope="col">Created</th>
            <th scope="col">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {models.map((model) => (
            <tr key={model.id}>
              <th scope="row" className="registry-table__model">
                <span className="registry-table__label">{model.label}</span>
                <span className="registry-table__ref">
                  {providerNames[model.provider]} / {model.modelId}
                </span>
                {model.notes && <span className="registry-table__notes">{model.notes}</span>}
              </th>
              <td>
                <span className="badge">{kindLabels[model.kind]}</span>
              </td>
              <td>
                <ModelStatusChip status={model.status} />
              </td>
              <td>
                {model.latestEval ? (
                  <span className="registry-table__eval">
                    <strong>{formatPercent(model.latestEval.passRate)}</strong>
                    <span className="registry-table__ref">
                      {model.latestEval.suiteId} · {formatTimestamp(model.latestEval.finishedAt)}
                    </span>
                  </span>
                ) : (
                  <span className="registry-table__ref">Not evaluated</span>
                )}
              </td>
              <td className="registry-table__date">{formatTimestamp(model.createdAt)}</td>
              <td>
                <div className="registry-table__actions">
                  {model.status !== "active" && (
                    <button
                      type="button"
                      className="button button--secondary button--small"
                      aria-label={`Promote ${model.label} to active`}
                      onClick={() => onChange({ model, mode: "active" })}
                    >
                      <ArrowUpCircle size={14} aria-hidden="true" />
                      Promote
                    </button>
                  )}
                  {model.status !== "retired" && (
                    <button
                      type="button"
                      className="button button--secondary button--small"
                      aria-label={`Retire ${model.label}`}
                      onClick={() => onChange({ model, mode: "retired" })}
                    >
                      <Archive size={14} aria-hidden="true" />
                      Retire
                    </button>
                  )}
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`Edit notes for ${model.label}`}
                    title="Edit notes"
                    onClick={() => onChange({ model, mode: "notes" })}
                  >
                    <NotebookPen size={15} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`Remove ${model.label} from the registry`}
                    title="Remove from the registry"
                    onClick={() => onDelete(model)}
                  >
                    <Trash2 size={15} aria-hidden="true" />
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Router ──────────────────────────────────────────────────────────────────

type RouterForm = {
  enabled: boolean;
  main: ModelRef | null;
  subagent: ModelRef | null;
  judge: ModelRef | null;
  fallback: ModelRef | null;
  canaryModel: ModelRef | null;
  canaryPercent: string;
};

const toForm = (config: RouterConfig): RouterForm => ({
  enabled: config.enabled,
  main: config.main,
  subagent: config.subagent,
  judge: config.judge,
  fallback: config.fallback,
  canaryModel: config.canary?.model ?? null,
  canaryPercent: String(config.canary?.percent ?? 10),
});

/** Field errors, or the config to save when there are none. */
export function validateRouter(form: RouterForm): {
  errors: Partial<Record<"main" | "fallback" | "canaryModel" | "canaryPercent", string>>;
  config: RouterConfig | null;
} {
  const errors: Partial<Record<"main" | "fallback" | "canaryModel" | "canaryPercent", string>> = {};
  if (form.enabled && !form.main) errors.main = "Choose a main model before turning the router on.";
  if (form.fallback && sameModel(form.fallback, form.main)) errors.fallback = "The fallback must differ from the main model.";
  const percent = Number(form.canaryPercent);
  if (form.canaryModel) {
    if (sameModel(form.canaryModel, form.main)) errors.canaryModel = "The canary must differ from the main model.";
    if (!Number.isInteger(percent) || percent < 1 || percent > 50) errors.canaryPercent = "Use a whole number from 1 to 50.";
  }
  if (Object.keys(errors).length > 0) return { errors, config: null };
  return {
    errors,
    config: {
      enabled: form.enabled,
      main: form.main,
      subagent: form.subagent,
      judge: form.judge,
      fallback: form.fallback,
      canary: form.canaryModel ? { model: form.canaryModel, percent } : null,
    },
  };
}

function RouterCard({ connections }: { connections: Connections }) {
  const id = useId();
  const router = useResource("router", fetchRouterConfig, "The router settings could not be loaded.");
  const [draft, setDraft] = useState<RouterForm | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const form = draft ?? (router.data ? toForm(router.data) : null);
  const { errors, config } = form ? validateRouter(form) : { errors: {}, config: null };
  const dirty = draft !== null && router.data !== undefined && JSON.stringify(draft) !== JSON.stringify(toForm(router.data));
  const shown = (field: keyof typeof errors) => (submitted ? errors[field] : undefined);

  const set = <K extends keyof RouterForm>(field: K, value: RouterForm[K]) => {
    if (!form) return;
    setDraft({ ...form, [field]: value });
    setSaved(false);
  };

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitted(true);
    setSaved(false);
    if (!config) return;
    setSaving(true);
    setError(null);
    try {
      const result = await saveRouterConfig(config);
      router.update(() => result);
      setDraft(null);
      setSubmitted(false);
      setSaved(true);
    } catch (caught) {
      setError(errorMessage(caught, "The router settings could not be saved."));
    } finally {
      setSaving(false);
    }
  }

  const select = (
    field: "main" | "subagent" | "judge" | "fallback" | "canaryModel",
    label: string,
    hint: string,
    emptyLabel?: string,
  ) => {
    const fieldError = field === "main" || field === "fallback" || field === "canaryModel" ? shown(field) : undefined;
    return (
      <Field
        label={label}
        htmlFor={`${id}-${field}`}
        hint={hint}
        hintId={`${id}-${field}-hint`}
        error={fieldError}
        errorId={`${id}-${field}-error`}
        optional={emptyLabel !== undefined}
      >
        <ModelSelect
          id={`${id}-${field}`}
          value={form?.[field] ?? null}
          onChange={(value) => set(field, value)}
          connections={connections}
          emptyLabel={emptyLabel}
          invalid={fieldError !== undefined}
          describedBy={`${id}-${field}-hint${fieldError ? ` ${id}-${field}-error` : ""}`}
        />
      </Field>
    );
  };

  return (
    <Panel
      title="Model router"
      description='Lets the server choose models for tasks sent with "Auto (router)" in the model picker.'
    >
      <Loadable loading={router.loading && router.data === undefined} error={router.error} onRetry={router.reload} what="router settings">
        {form && (
          <form className="training-form" onSubmit={(event) => void onSubmit(event)} noValidate>
            <div className="switch-row">
              <Switch checked={form.enabled} label="Use the router" onChange={(value) => set("enabled", value)} />
              <span className="switch-row__text">
                <span className="switch-row__label" aria-hidden="true">
                  Use the router
                </span>
                <span className="switch-row__hint">
                  When off, &quot;Auto (router)&quot; is hidden and every task runs on the model picked in the composer.
                </span>
              </span>
            </div>
            <div className="training-form__grid">
              {select("main", "Main model", "Answers tasks sent with Auto. Required while the router is on.")}
              {select(
                "subagent",
                "Sub-agent model",
                "Runs delegated research, review and test tasks. A smaller, faster model often works well.",
                "Same as the task's model",
              )}
              {select(
                "judge",
                "Judge model",
                "Grades evaluation answers by default when a run has no judge of its own.",
                "None",
              )}
              {select(
                "fallback",
                "Fallback model",
                "Answers when the main model is unreachable or fails with a server error.",
                "None",
              )}
            </div>
            <fieldset className="hyperparameters">
              <legend className="field-label">Canary</legend>
              <p className="form-field__hint">
                Sends a share of new tasks to a candidate model so you can judge it on real work. A task keeps the model
                it started with.
              </p>
              <div className="training-form__grid">
                {select("canaryModel", "Canary model", "Compare its replies and ratings with the main model's.", "No canary")}
                {form.canaryModel && (
                  <Field
                    label="Share of new tasks (%)"
                    htmlFor={`${id}-percent`}
                    hint="From 1 to 50."
                    hintId={`${id}-percent-hint`}
                    error={shown("canaryPercent")}
                    errorId={`${id}-percent-error`}
                  >
                    <NumberField
                      id={`${id}-percent`}
                      value={form.canaryPercent}
                      onChange={(value) => set("canaryPercent", value)}
                      step={1}
                      min={1}
                      max={50}
                      invalid={shown("canaryPercent") !== undefined}
                      describedBy={shown("canaryPercent") ? `${id}-percent-error` : `${id}-percent-hint`}
                    />
                  </Field>
                )}
              </div>
            </fieldset>
            {error && <Alert message={error} onDismiss={() => setError(null)} />}
            <div className="training-form__actions">
              <span className="training-form__status" aria-live="polite">
                {saved ? (
                  <>
                    <Check size={15} aria-hidden="true" /> Saved
                  </>
                ) : dirty ? (
                  "Unsaved changes"
                ) : null}
              </span>
              {dirty && (
                <button
                  type="button"
                  className="button button--ghost"
                  onClick={() => {
                    setDraft(null);
                    setSubmitted(false);
                    setError(null);
                  }}
                >
                  Discard
                </button>
              )}
              <button type="submit" className="button button--primary" disabled={saving || !dirty}>
                {saving ? "Saving…" : "Save router"}
              </button>
            </div>
            {form.enabled && form.main && (
              <p className="form-field__hint">Auto currently means {modelRefLabel(form.main)}.</p>
            )}
          </form>
        )}
      </Loadable>
    </Panel>
  );
}

// ── Tab ─────────────────────────────────────────────────────────────────────

/** The model registry (candidates, active and retired models) and the router that serves "Auto". */
export function ModelsTab({ connections }: { connections: Connections }) {
  const registry = useResource("registry", fetchRegistry, "The model registry could not be loaded.");
  const [change, setChange] = useState<StatusChange | null>(null);
  const [removing, setRemoving] = useState<RegisteredModel | null>(null);
  const models = registry.data ?? [];

  const replace = (model: RegisteredModel) =>
    registry.update((list) => list.map((item) => (item.id === model.id ? model : item)));

  return (
    <div className="training-stack">
      <Panel
        title="Registry"
        description="Track base models, fine-tunes and distilled models with their latest evaluation. Promote the ones you trust."
      >
        <Loadable loading={registry.loading && registry.data === undefined} error={registry.error} onRetry={registry.reload} what="models">
          <RegistryTable models={models} onChange={setChange} onDelete={setRemoving} />
        </Loadable>
      </Panel>
      <Panel title="Register a model" description="Pick a model your connections serve, for example a fine-tune you just loaded.">
        <RegisterForm
          connections={connections}
          models={models}
          onRegistered={(model) => registry.update((list) => [model, ...list.filter((item) => item.id !== model.id)])}
        />
      </Panel>
      <RouterCard connections={connections} />
      {change && (
        <StatusDialog
          change={change}
          onClose={() => setChange(null)}
          onSaved={(model) => {
            replace(model);
            setChange(null);
          }}
        />
      )}
      {removing && (
        <ConfirmDialog
          title="Remove model"
          confirmLabel="Remove"
          onClose={() => setRemoving(null)}
          onConfirm={async () => {
            await deleteModel(removing.id);
            registry.update((list) => list.filter((item) => item.id !== removing.id));
            setRemoving(null);
          }}
        >
          <p className="confirm-text">
            Remove {removing.label} from the registry? The model itself stays on its server; only this record goes.
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}
