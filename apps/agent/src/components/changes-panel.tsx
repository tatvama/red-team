"use client";

import { CircleAlert, Columns2, GitBranch, GitCompare, LoaderCircle, RefreshCw, Rows2, X } from "lucide-react";
import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import type { CheckpointView, GitChanges } from "@/lib/contract";
import { CheckpointTimeline } from "./checkpoint-timeline";
import { DiffFileView, DiffStat, type DiffViewMode } from "./diff-viewer";
import { type GitActionName, GitActions } from "./git-actions";
import { Segmented, type SegmentedOption } from "./segmented";

export type ChangesTab = "diff" | "timeline";

const tabs: { id: ChangesTab; label: string }[] = [
  { id: "diff", label: "Diff" },
  { id: "timeline", label: "Timeline" },
];

const viewOptions: SegmentedOption<DiffViewMode>[] = [
  { value: "unified", label: "Unified", icon: Rows2 },
  { value: "split", label: "Split", icon: Columns2 },
];

/** Files open by default when there are only a few of them. */
const OPEN_FILES_LIMIT = 8;

function ChangesSummary({ changes }: { changes: GitChanges }) {
  const { workspace, ahead, hasUncommitted, files } = changes;
  const facts: string[] = [];
  if (ahead > 0) facts.push(ahead === 1 ? "1 commit ahead" : `${ahead} commits ahead`);
  if (hasUncommitted) facts.push("uncommitted changes");
  return (
    <div className="changes-summary">
      {workspace.branch && (
        <p className="changes-summary__branches">
          <GitBranch size={14} aria-hidden="true" />
          <code>{workspace.branch}</code>
          {workspace.baseBranch && workspace.baseBranch !== workspace.branch && (
            <>
              <span aria-hidden="true">→</span>
              <span className="sr-only">based on</span>
              <code>{workspace.baseBranch}</code>
            </>
          )}
        </p>
      )}
      <p className="changes-summary__facts">
        {files.length === 0
          ? "No changes yet."
          : `${files.length === 1 ? "1 file" : `${files.length} files`} changed`}
        {files.length > 0 && <DiffStat additions={changes.additions} deletions={changes.deletions} />}
        {facts.length > 0 && <span className="changes-summary__state">{facts.join(" · ")}</span>}
      </p>
    </div>
  );
}

type ChangesPanelProps = {
  id?: string;
  conversationId: string;
  /** Conversation title, to prefill commit and pull request forms. */
  title: string;
  changes: GitChanges | null;
  /** Why the last load failed. */
  error: string | null;
  checkpoints: CheckpointView[];
  /** True while the agent runs in this tab: git and restore actions wait. */
  busy: boolean;
  initialTab?: ChangesTab;
  onClose: () => void;
  onRefresh: () => Promise<void>;
  onGitDone: (action: GitActionName) => void;
  onRestore: (checkpoint: CheckpointView, rewindConversation: boolean) => void;
};

/** Right-hand panel for reviewing the task's git changes and its checkpoints. */
export function ChangesPanel({
  id,
  conversationId,
  title,
  changes,
  error,
  checkpoints,
  busy,
  initialTab = "diff",
  onClose,
  onRefresh,
  onGitDone,
  onRestore,
}: ChangesPanelProps) {
  const [tab, setTab] = useState<ChangesTab>(initialTab);
  const [view, setView] = useState<DiffViewMode>("unified");
  const [refreshing, setRefreshing] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const baseId = useId();

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  async function refresh() {
    setRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setRefreshing(false);
    }
  }

  function onPanelKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape" && !event.defaultPrevented) {
      event.preventDefault();
      onClose();
    }
  }

  function onTabKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const index = tabs.findIndex((item) => item.id === tab);
    const next =
      event.key === "ArrowRight" || event.key === "End"
        ? tabs[event.key === "End" ? tabs.length - 1 : (index + 1) % tabs.length]
        : event.key === "ArrowLeft" || event.key === "Home"
          ? tabs[event.key === "Home" ? 0 : (index - 1 + tabs.length) % tabs.length]
          : null;
    if (!next) return;
    event.preventDefault();
    setTab(next.id);
    document.getElementById(`${baseId}-tab-${next.id}`)?.focus();
  }

  function renderDiff() {
    if (!changes) {
      return error ? (
        <div className="panel-empty" role="alert">
          <CircleAlert size={20} aria-hidden="true" />
          <p>{error}</p>
          <button type="button" className="button button--secondary button--small" onClick={() => void refresh()}>
            Try again
          </button>
        </div>
      ) : (
        <div className="panel-empty" aria-live="polite">
          <LoaderCircle size={20} aria-hidden="true" className="spin" />
          <p>Loading changes…</p>
        </div>
      );
    }
    if (!changes.available) {
      return (
        <div className="panel-empty">
          <GitCompare size={20} aria-hidden="true" />
          <p>{changes.reason ?? "Git review is not available for this task."}</p>
        </div>
      );
    }
    return (
      <>
        <ChangesSummary changes={changes} />
        <GitActions
          conversationId={conversationId}
          changes={changes}
          title={title}
          disabled={busy}
          onDone={onGitDone}
        />
        {changes.files.length > 0 && (
          <div className="changes-toolbar">
            <h3 className="changes-toolbar__title">Files</h3>
            <Segmented label="Diff layout" value={view} options={viewOptions} onChange={setView} compact />
          </div>
        )}
        {changes.truncated && (
          <p className="changes-note">Some files were left out to keep this view fast.</p>
        )}
        <div className="diff-files">
          {changes.files.map((file) => (
            <DiffFileView
              key={`${file.oldPath ?? ""}:${file.path}`}
              file={file}
              view={view}
              defaultOpen={changes.files.length <= OPEN_FILES_LIMIT}
            />
          ))}
        </div>
      </>
    );
  }

  return (
    <aside id={id} className="side-panel" aria-labelledby={`${baseId}-title`} onKeyDown={onPanelKeyDown}>
      <header className="side-panel__header">
        <GitCompare size={16} aria-hidden="true" />
        <h2 id={`${baseId}-title`} ref={headingRef} tabIndex={-1}>
          Changes
        </h2>
        {error && changes && (
          <span className="side-panel__error" role="alert" title={error}>
            <CircleAlert size={14} aria-hidden="true" />
            <span className="sr-only">{error}</span>
          </span>
        )}
        <button
          type="button"
          className="icon-button"
          aria-label="Refresh changes"
          disabled={refreshing}
          onClick={() => void refresh()}
        >
          <RefreshCw size={16} aria-hidden="true" className={refreshing ? "spin" : undefined} />
        </button>
        <button type="button" className="icon-button" aria-label="Close changes" onClick={onClose}>
          <X size={17} aria-hidden="true" />
        </button>
      </header>
      <div className="side-panel__tabs" role="tablist" aria-label="Changes views" onKeyDown={onTabKeyDown}>
        {tabs.map((item) => (
          <button
            key={item.id}
            id={`${baseId}-tab-${item.id}`}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            aria-controls={`${baseId}-panel`}
            tabIndex={tab === item.id ? 0 : -1}
            className="side-panel__tab"
            onClick={() => setTab(item.id)}
          >
            {item.label}
            {item.id === "timeline" && checkpoints.length > 0 && (
              <span className="side-panel__count">{checkpoints.length}</span>
            )}
          </button>
        ))}
      </div>
      <div
        id={`${baseId}-panel`}
        className="side-panel__body"
        role="tabpanel"
        aria-labelledby={`${baseId}-tab-${tab}`}
        tabIndex={0}
      >
        {tab === "diff" ? (
          renderDiff()
        ) : (
          <CheckpointTimeline checkpoints={checkpoints} disabled={busy} onRestore={onRestore} />
        )}
      </div>
    </aside>
  );
}
