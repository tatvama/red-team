"use client";

import {
  CircleAlert,
  CircleCheck,
  ExternalLink,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequestCreate,
  Trash2,
  Upload,
} from "lucide-react";
import { type FormEvent, type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import type { GitAction, GitActionResult, GitChanges } from "@/lib/contract";
import { errorMessage, runGitAction } from "@/lib/client/api";
import { isHttpUrl } from "@/lib/client/format";

export type GitActionName = GitAction["action"];

type OpenForm = "commit" | "pull_request" | "merge" | "discard" | null;

/** A web compare page for the task branch, for remotes where Tatvam cannot open the pull request itself. */
export function compareUrl(webUrl: string, baseBranch: string | null, branch: string | null): string {
  const root = webUrl.replace(/\/+$/, "");
  if (!baseBranch || !branch || baseBranch === branch) return root;
  const ref = (name: string) => name.split("/").map(encodeURIComponent).join("/");
  return `${root}/compare/${ref(baseBranch)}...${ref(branch)}`;
}

const pendingLabels: Record<GitActionName, string> = {
  commit: "Committing…",
  push: "Pushing…",
  pull_request: "Creating pull request…",
  merge: "Merging…",
  discard: "Discarding worktree…",
};

type GitActionsProps = {
  conversationId: string;
  changes: GitChanges;
  /** Conversation title, used to prefill the commit message and pull request title. */
  title: string;
  /** True while the agent runs: the server refuses git actions then. */
  disabled: boolean;
  onDone: (action: GitActionName) => void;
};

export function GitActions({ conversationId, changes, title, disabled, onDone }: GitActionsProps) {
  const [form, setForm] = useState<OpenForm>(null);
  const [pending, setPending] = useState<GitActionName | null>(null);
  const [result, setResult] = useState<GitActionResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [commitMessage, setCommitMessage] = useState(title);
  const [prTitle, setPrTitle] = useState(title);
  const [prBody, setPrBody] = useState("");
  const [prDraft, setPrDraft] = useState(false);
  const formRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const baseId = useId();

  const { workspace, remote } = changes;
  const worktree = workspace.mode === "worktree";
  const baseBranch = workspace.baseBranch ?? "the base branch";
  const busy = disabled || pending !== null;

  // Move focus into a form or confirmation when it opens.
  useEffect(() => {
    if (form) formRef.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
  }, [form]);

  function open(next: Exclude<OpenForm, null>, trigger: HTMLButtonElement) {
    triggerRef.current = trigger;
    setError(null);
    setResult(null);
    if (next === "commit" && form !== "commit") setCommitMessage(title);
    if (next === "pull_request" && form !== "pull_request") setPrTitle(title);
    setForm(form === next ? null : next);
  }

  function cancel() {
    setForm(null);
    triggerRef.current?.focus();
  }

  async function run(action: GitAction) {
    setPending(action.action);
    setError(null);
    setResult(null);
    try {
      const outcome = await runGitAction(conversationId, action);
      setResult(outcome);
      setForm(null);
      onDone(action.action);
    } catch (caught) {
      setError(errorMessage(caught, "The git action failed. Please try again."));
    } finally {
      setPending(null);
    }
  }

  function onFormKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key !== "Escape") return;
    // Cancels this form only; the panel stays open.
    event.stopPropagation();
    cancel();
  }

  function submitCommit(event: FormEvent) {
    event.preventDefault();
    const message = commitMessage.trim();
    if (message) void run({ action: "commit", message });
  }

  function submitPullRequest(event: FormEvent) {
    event.preventDefault();
    const trimmed = prTitle.trim();
    if (trimmed) void run({ action: "pull_request", title: trimmed, body: prBody, draft: prDraft });
  }

  const compareLink =
    !changes.canOpenPullRequest && remote && isHttpUrl(remote.webUrl)
      ? compareUrl(remote.webUrl, workspace.baseBranch, workspace.branch)
      : null;

  return (
    <div className="git-actions">
      <div className="git-actions__row" role="group" aria-label="Git actions">
        <button
          type="button"
          className="button button--secondary button--small"
          aria-expanded={form === "commit"}
          aria-controls={form === "commit" ? `${baseId}-form` : undefined}
          disabled={busy || !changes.hasUncommitted}
          title={changes.hasUncommitted ? undefined : "Nothing to commit"}
          onClick={(event) => open("commit", event.currentTarget)}
        >
          <GitCommitHorizontal size={14} aria-hidden="true" />
          Commit
        </button>
        {remote && (
          <button
            type="button"
            className="button button--secondary button--small"
            disabled={busy}
            onClick={() => void run({ action: "push" })}
          >
            <Upload size={14} aria-hidden="true" />
            Push
          </button>
        )}
        {changes.canOpenPullRequest && (
          <button
            type="button"
            className="button button--secondary button--small"
            aria-expanded={form === "pull_request"}
            aria-controls={form === "pull_request" ? `${baseId}-form` : undefined}
            disabled={busy}
            onClick={(event) => open("pull_request", event.currentTarget)}
          >
            <GitPullRequestCreate size={14} aria-hidden="true" />
            Create pull request
          </button>
        )}
        {compareLink && (
          <a className="button button--secondary button--small" href={compareLink} target="_blank" rel="noreferrer">
            <ExternalLink size={14} aria-hidden="true" />
            Open compare page
          </a>
        )}
        {worktree && (
          <>
            <button
              type="button"
              className="button button--secondary button--small"
              aria-expanded={form === "merge"}
              disabled={busy}
              onClick={(event) => open("merge", event.currentTarget)}
            >
              <GitMerge size={14} aria-hidden="true" />
              Merge into {baseBranch}
            </button>
            <button
              type="button"
              className="button button--ghost button--small git-actions__danger"
              aria-expanded={form === "discard"}
              disabled={busy}
              onClick={(event) => open("discard", event.currentTarget)}
            >
              <Trash2 size={14} aria-hidden="true" />
              Discard worktree
            </button>
          </>
        )}
      </div>

      {form && (
        <div ref={formRef} id={`${baseId}-form`} className="git-form" onKeyDown={onFormKeyDown}>
          {form === "commit" && (
            <form onSubmit={submitCommit} aria-label="Commit changes">
              <label className="field-label" htmlFor={`${baseId}-commit`}>
                Commit message
              </label>
              <textarea
                id={`${baseId}-commit`}
                className="field field--textarea"
                rows={3}
                maxLength={5000}
                value={commitMessage}
                data-autofocus
                onChange={(event) => setCommitMessage(event.target.value)}
              />
              <div className="git-form__actions">
                <button type="button" className="button button--ghost button--small" onClick={cancel}>
                  Cancel
                </button>
                <button type="submit" className="button button--primary button--small" disabled={busy || !commitMessage.trim()}>
                  Commit
                </button>
              </div>
            </form>
          )}
          {form === "pull_request" && (
            <form onSubmit={submitPullRequest} aria-label="Create pull request">
              <label className="field-label" htmlFor={`${baseId}-pr-title`}>
                Title
              </label>
              <input
                id={`${baseId}-pr-title`}
                className="field"
                maxLength={256}
                value={prTitle}
                data-autofocus
                onChange={(event) => setPrTitle(event.target.value)}
              />
              <label className="field-label" htmlFor={`${baseId}-pr-body`}>
                Description
              </label>
              <textarea
                id={`${baseId}-pr-body`}
                className="field field--textarea"
                rows={4}
                maxLength={20_000}
                value={prBody}
                onChange={(event) => setPrBody(event.target.value)}
              />
              <label className="checkbox">
                <input type="checkbox" checked={prDraft} onChange={(event) => setPrDraft(event.target.checked)} />
                Open as a draft
              </label>
              <div className="git-form__actions">
                <button type="button" className="button button--ghost button--small" onClick={cancel}>
                  Cancel
                </button>
                <button type="submit" className="button button--primary button--small" disabled={busy || !prTitle.trim()}>
                  Create pull request
                </button>
              </div>
            </form>
          )}
          {form === "merge" && (
            <div className="git-confirm" role="group" aria-labelledby={`${baseId}-merge-text`}>
              <p id={`${baseId}-merge-text`}>
                Merge <code>{workspace.branch ?? "the task branch"}</code> into <code>{baseBranch}</code> in the main
                checkout? Commit any changes you want to keep first.
              </p>
              <div className="git-form__actions">
                <button type="button" className="button button--ghost button--small" onClick={cancel}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="button button--primary button--small"
                  data-autofocus
                  disabled={busy}
                  onClick={() => void run({ action: "merge" })}
                >
                  Merge
                </button>
              </div>
            </div>
          )}
          {form === "discard" && (
            <div className="git-confirm git-confirm--danger" role="group" aria-labelledby={`${baseId}-discard-text`}>
              <p id={`${baseId}-discard-text`}>
                Discard this worktree? Its folder and the branch <code>{workspace.branch ?? "for this task"}</code> are
                deleted. Uncommitted and unmerged work is lost and cannot be recovered.
              </p>
              <div className="git-form__actions">
                <button type="button" className="button button--ghost button--small" data-autofocus onClick={cancel}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="button button--danger button--small"
                  disabled={busy}
                  onClick={() => void run({ action: "discard" })}
                >
                  Discard worktree
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      <div className="git-actions__status" aria-live="polite">
        {pending && <p className="git-status">{pendingLabels[pending]}</p>}
        {result && (
          <p className="git-status git-status--ok">
            <CircleCheck size={15} aria-hidden="true" />
            <span>
              {result.message}
              {isHttpUrl(result.url) && (
                <>
                  {" "}
                  <a href={result.url} target="_blank" rel="noreferrer">
                    Open
                    <ExternalLink size={12} aria-hidden="true" />
                    <span className="sr-only"> (opens in a new tab)</span>
                  </a>
                </>
              )}
            </span>
          </p>
        )}
      </div>
      {error && (
        <p className="git-status git-status--error" role="alert">
          <CircleAlert size={15} aria-hidden="true" />
          <span>{error}</span>
        </p>
      )}
    </div>
  );
}
