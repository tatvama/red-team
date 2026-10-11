"use client";

import {
  CircleAlert,
  CircleCheck,
  FlaskConical,
  GitBranch,
  GitCompare,
  ListChecks,
  LoaderCircle,
  Menu,
  Plus,
  RefreshCw,
  Settings,
  X,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import Link from "next/link";
import type {
  CheckpointView,
  ConversationKind,
  DefaultWorkspaceView,
  FeedbackRequest,
  Isolation,
  PermissionMode,
  RouterConfig,
  SessionView,
  TrainingStatus,
} from "@/lib/contract";
import { agentReducer, createInitialState, type ModelSelection, parseAgentEvent, resolveChoice } from "@/lib/client/agent-state";
import {
  ApiError,
  deleteConversation,
  errorMessage,
  fetchChanges,
  fetchConversation,
  fetchConversations,
  fetchDefaultWorkspace,
  fetchModels,
  fetchRouterConfig,
  fetchSession,
  LOGIN_PATH,
  logout,
  renameConversation,
  restoreCheckpoint,
  saveFeedback,
  saveTrainingStatus,
  startAgent,
  submitApproval,
} from "@/lib/client/api";
import { findFeedback, optimisticFeedback } from "@/lib/client/feedback";
import { navigateTo } from "@/lib/client/navigation";
import { readNdjson } from "@/lib/client/ndjson";
import { usePreferences, writePreferences } from "@/lib/client/storage";
import type { ApprovalDecision } from "./approval-card";
import { ChangesPanel } from "./changes-panel";
import { Composer } from "./composer";
import { DiffStat } from "./diff-viewer";
import { EmptyState } from "./empty-state";
import { IsolationToggle } from "./isolation-toggle";
import { ModePicker } from "./mode-picker";
import { ModelPicker, providers } from "./model-picker";
import { PlanBar, PlanPanel, planProgress } from "./plan-panel";
import { RestoreDialog } from "./restore-dialog";
import { SettingsDialog } from "./settings-dialog";
import { Sidebar } from "./sidebar";
import { TrainingStatusControl } from "./training-status";
import { Transcript } from "./transcript";

type OpenStream = (signal: AbortSignal) => Promise<ReadableStream<Uint8Array>>;

/** Gives the server time to persist partial output after a stop before the canonical refetch. */
const REFRESH_AFTER_STOP_MS = 600;

function conversationIdFromPath(pathname: string): string | null {
  const match = /^\/c\/([^/]+)\/?$/.exec(pathname);
  return match ? decodeURIComponent(match[1]) : null;
}

const conversationUrl = (id: string) => `/c/${encodeURIComponent(id)}`;

const CHANGES_PANEL_ID = "changes-panel";

type RestoreTarget = { checkpoint: CheckpointView; allowRewind: boolean };

/** What background jobs made; these conversations open read-only. */
const jobConversations: Record<Exclude<ConversationKind, "chat">, { badge: string; text: string; href: string }> = {
  eval: {
    badge: "Evaluation",
    href: "/training?tab=evaluations",
    text: "An evaluation run created this conversation to test a model on one task. It is read-only.",
  },
  distill: {
    badge: "Distillation",
    href: "/training?tab=distillation",
    text: "A distillation job created this conversation: a teacher model's answer kept as training data. It is read-only.",
  },
};

export function AgentApp({ initialConversationId }: { initialConversationId: string | null }) {
  const [state, dispatch] = useReducer(agentReducer, initialConversationId, createInitialState);
  const preferences = usePreferences();
  /** The server's model router; null until loaded (or when the server has none). */
  const [router, setRouter] = useState<RouterConfig | null>(null);
  const selection = useMemo(
    () => resolveChoice(preferences, state.connections, router),
    [preferences, state.connections, router],
  );
  const permissionMode = preferences.permissionMode;
  const [draft, setDraft] = useState("");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [planOpen, setPlanOpen] = useState(true);
  const [changesOpen, setChangesOpen] = useState(false);
  const [restoreTarget, setRestoreTarget] = useState<RestoreTarget | null>(null);
  const [defaultWorkspace, setDefaultWorkspace] = useState<DefaultWorkspaceView | null>(null);
  const [session, setSession] = useState<SessionView | null>(null);
  /** A short confirmation, for example after restoring a checkpoint. */
  const [notice, setNotice] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const changesButtonRef = useRef<HTMLButtonElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const runCounter = useRef(0);
  /** Feedback saves in flight; only the last answer replaces the list, so quick clicks do not flicker. */
  const pendingFeedback = useRef(0);

  const running = state.phase === "streaming";
  const { conversationId } = state;

  const refreshConversations = useCallback(async () => {
    try {
      dispatch({ type: "conversations_loaded", conversations: await fetchConversations() });
    } catch {
      // The sidebar keeps showing the last list it had.
    }
  }, []);

  const checkConnections = useCallback(() => {
    for (const provider of providers) {
      fetchModels(provider)
        .then((connection) => dispatch({ type: "connection_loaded", connection }))
        .catch(() => dispatch({ type: "connection_loaded", connection: { provider, state: "offline", models: [] } }));
    }
  }, []);

  /** Fetches the git review data; the reducer drops results for a conversation that is no longer shown. */
  const refreshChanges = useCallback(async (id: string) => {
    try {
      dispatch({ type: "changes_loaded", conversationId: id, changes: await fetchChanges(id) });
    } catch (error) {
      dispatch({ type: "changes_failure", conversationId: id, message: errorMessage(error, "Changes could not be loaded.") });
    }
  }, []);

  /**
   * Loads a conversation, or refetches it for canonical state, together with its changes.
   * The reducer drops stale results.
   */
  const loadConversation = useCallback(async (id: string) => {
    void refreshChanges(id);
    try {
      dispatch({ type: "conversation_loaded", conversation: await fetchConversation(id) });
    } catch (error) {
      const message =
        error instanceof ApiError && error.status === 404
          ? "This task does not exist or was deleted."
          : errorMessage(error, "This task could not be loaded.");
      dispatch({ type: "load_failure", conversationId: id, message });
    }
  }, [refreshChanges]);

  useEffect(() => {
    void refreshConversations();
    checkConnections();
    if (initialConversationId) void loadConversation(initialConversationId);
  }, [initialConversationId, refreshConversations, checkConnections, loadConversation]);

  useEffect(() => () => abortRef.current?.abort(), []);

  // "Auto (router)" is offered while the server's router is enabled.
  useEffect(() => {
    let cancelled = false;
    fetchRouterConfig()
      .then((config) => {
        if (!cancelled) setRouter(config);
      })
      .catch(() => {
        // No router (or an older server): the picker offers concrete models only.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // A remote session gets a Sign out button.
  useEffect(() => {
    let cancelled = false;
    fetchSession()
      .then((view) => {
        if (!cancelled) setSession(view);
      })
      .catch(() => {
        // Older servers have no session endpoint; nothing to sign out of then.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // A new task in a git workspace can run in its own worktree.
  const isNewTask = conversationId === null;
  useEffect(() => {
    if (!isNewTask) return;
    let cancelled = false;
    fetchDefaultWorkspace()
      .then((workspace) => {
        if (!cancelled) setDefaultWorkspace(workspace);
      })
      .catch(() => {
        if (!cancelled) setDefaultWorkspace(null);
      });
    return () => {
      cancelled = true;
    };
  }, [isNewTask]);

  // Conversations switch in place (pushState), so back and forward are handled here too.
  useEffect(() => {
    const onPopState = () => {
      abortRef.current?.abort();
      const id = conversationIdFromPath(window.location.pathname);
      if (id) {
        dispatch({ type: "load_start", conversationId: id });
        void loadConversation(id);
      } else {
        dispatch({ type: "new_task" });
      }
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [loadConversation]);

  useEffect(() => {
    document.title = state.title ? `${state.title} · Tatvam` : "Tatvam";
  }, [state.title]);

  const runStream = useCallback(
    async (runId: number, startId: string | null, open: OpenStream, onRejected: (message: string) => void) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      let currentId = startId;
      try {
        let body: ReadableStream<Uint8Array>;
        try {
          body = await open(controller.signal);
        } catch (error) {
          if (!controller.signal.aborted) onRejected(errorMessage(error, "The agent could not be started."));
          return;
        }
        for await (const value of readNdjson(body)) {
          if (controller.signal.aborted) break;
          const event = parseAgentEvent(value);
          if (!event) continue;
          if (event.type === "conversation") {
            currentId = event.conversation.id;
            // Not router.push: that would remount the app in the middle of the stream.
            window.history.replaceState(null, "", conversationUrl(currentId));
          }
          dispatch({ type: "event", event });
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          dispatch({ type: "run_failure", runId, message: errorMessage(error, "The connection to the agent was lost.") });
        }
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
        const stopped = controller.signal.aborted;
        dispatch({ type: "run_end", runId, stopped });
        const refreshId = currentId;
        if (refreshId) setTimeout(() => void loadConversation(refreshId), stopped ? REFRESH_AFTER_STOP_MS : 0);
        void refreshConversations();
      }
    },
    [loadConversation, refreshConversations],
  );

  const offerIsolation = isNewTask && defaultWorkspace?.isGitRepo === true;

  const send = useCallback(
    (content: string) => {
      if (!selection || state.phase !== "idle") return;
      const runId = ++runCounter.current;
      const startId = conversationId;
      // Only a new conversation takes an isolation choice, and only a git workspace offers one.
      const isolation: Isolation | undefined = startId === null && offerIsolation ? preferences.isolation : undefined;
      setNotice(null);
      dispatch({
        type: "send",
        runId,
        message: { id: `local-${runId}`, role: "user", content, createdAt: new Date().toISOString() },
      });
      setDraft("");
      void runStream(
        runId,
        startId,
        (signal) =>
          startAgent(
            {
              conversationId: startId ?? undefined,
              provider: selection.provider,
              model: selection.model,
              permissionMode,
              content,
              ...(isolation ? { isolation } : {}),
              ...(selection.auto ? { useRouter: true } : {}),
            },
            signal,
          ),
        (message) => {
          dispatch({ type: "send_failure", runId, message });
          setDraft((current) => current || content);
        },
      );
    },
    [selection, state.phase, conversationId, offerIsolation, preferences.isolation, permissionMode, runStream],
  );

  /** Resumes the conversation without a new message: Retry after an error, Continue after the step limit. */
  const resume = useCallback(() => {
    if (!selection || !conversationId || running) return;
    const runId = ++runCounter.current;
    dispatch({ type: "run_start", runId });
    void runStream(
      runId,
      conversationId,
      (signal) =>
        startAgent(
          {
            conversationId,
            provider: selection.provider,
            model: selection.model,
            permissionMode,
            ...(selection.auto ? { useRouter: true } : {}),
          },
          signal,
        ),
      (message) => dispatch({ type: "run_failure", runId, message }),
    );
  }, [selection, conversationId, running, permissionMode, runStream]);

  const decide = useCallback(
    (callId: string, decision: ApprovalDecision) => {
      if (!selection || !conversationId || running) return;
      const runId = ++runCounter.current;
      dispatch({ type: "run_start", runId });
      void runStream(
        runId,
        conversationId,
        (signal) =>
          submitApproval(
            {
              conversationId,
              callId,
              decision,
              provider: selection.provider,
              model: selection.model,
              permissionMode,
              ...(selection.auto ? { useRouter: true } : {}),
            },
            signal,
          ),
        (message) => dispatch({ type: "run_failure", runId, message }),
      );
    },
    [selection, conversationId, running, permissionMode, runStream],
  );

  const stop = useCallback(() => abortRef.current?.abort(), []);

  const newTask = useCallback(() => {
    abortRef.current?.abort();
    setDrawerOpen(false);
    setChangesOpen(false);
    setNotice(null);
    if (window.location.pathname !== "/") window.history.pushState(null, "", "/");
    dispatch({ type: "new_task" });
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  const openConversation = useCallback(
    (id: string) => {
      setDrawerOpen(false);
      if (id === conversationId) return;
      abortRef.current?.abort();
      setNotice(null);
      window.history.pushState(null, "", conversationUrl(id));
      dispatch({ type: "load_start", conversationId: id });
      void loadConversation(id);
    },
    [conversationId, loadConversation],
  );

  const rename = useCallback(async (id: string, title: string) => {
    dispatch({ type: "conversation_renamed", conversation: await renameConversation(id, title) });
  }, []);

  const remove = useCallback(
    async (id: string) => {
      await deleteConversation(id);
      dispatch({ type: "conversation_deleted", conversationId: id });
      if (id === conversationId) newTask();
    },
    [conversationId, newTask],
  );

  const selectModel = useCallback((next: ModelSelection) => writePreferences({ ...next, useRouter: false }), []);
  const selectAuto = useCallback(() => writePreferences({ useRouter: true }), []);

  /** Saves a rating or correction, showing it at once and reverting if the server refuses it. */
  const giveFeedback = useCallback(
    async (request: FeedbackRequest) => {
      if (!conversationId) return;
      const { messageId, toolCallId } = request;
      const previous = findFeedback(state.feedback, messageId, toolCallId);
      const optimistic = optimisticFeedback(request);
      dispatch({ type: "feedback_entry", conversationId, messageId, toolCallId, entry: optimistic });
      pendingFeedback.current += 1;
      try {
        const feedback = await saveFeedback(conversationId, request);
        pendingFeedback.current -= 1;
        if (pendingFeedback.current === 0) dispatch({ type: "feedback_loaded", conversationId, feedback });
      } catch (error) {
        pendingFeedback.current -= 1;
        dispatch({ type: "feedback_entry", conversationId, messageId, toolCallId, entry: previous, ifCurrent: optimistic });
        throw error;
      }
    },
    [conversationId, state.feedback],
  );

  const changeTrainingStatus = useCallback(
    async (status: TrainingStatus) => {
      if (!conversationId || state.trainingStatus === null) return;
      const previous = state.trainingStatus;
      dispatch({ type: "training_status", conversationId, trainingStatus: status });
      try {
        await saveTrainingStatus(conversationId, status);
      } catch (error) {
        dispatch({ type: "training_status", conversationId, trainingStatus: previous, ifCurrent: status });
        throw error;
      }
    },
    [conversationId, state.trainingStatus],
  );
  const selectMode = useCallback((mode: PermissionMode) => writePreferences({ permissionMode: mode }), []);
  const selectIsolation = useCallback((isolation: Isolation) => writePreferences({ isolation }), []);

  const openChanges = useCallback(() => {
    if (!conversationId) return;
    setChangesOpen(true);
    void refreshChanges(conversationId);
  }, [conversationId, refreshChanges]);

  const closeChanges = useCallback(() => {
    setChangesOpen(false);
    changesButtonRef.current?.focus();
  }, []);

  /** Git actions change the branch, the worktree or both; refetch the conversation and its changes. */
  const onGitDone = useCallback(() => {
    if (conversationId) void loadConversation(conversationId);
  }, [conversationId, loadConversation]);

  // Focus the composer in a passive effect: it runs in the same commit that closes the restore
  // dialog, after the dialog's own cleanup has handed focus back to its trigger, so it always wins.
  const [composerFocusRequest, setComposerFocusRequest] = useState(0);
  useEffect(() => {
    if (composerFocusRequest) inputRef.current?.focus();
  }, [composerFocusRequest]);

  const requestRestore = useCallback((checkpoint: CheckpointView, allowRewind: boolean) => {
    setRestoreTarget({ checkpoint, allowRewind });
  }, []);

  /** Runs a restore from the dialog. Errors propagate so the dialog can show them and stay open. */
  const confirmRestore = useCallback(
    async (checkpoint: CheckpointView, rewindConversation: boolean) => {
      if (!conversationId) return;
      const result = await restoreCheckpoint(conversationId, { checkpointId: checkpoint.id, rewindConversation });
      setRestoreTarget(null);
      setNotice(result.message);
      const prompt = result.restoredPrompt;
      if (prompt) {
        // Never drop a draft in progress: the restored message goes first.
        setDraft((current) => (current.trim() ? `${prompt}\n\n${current}` : prompt));
        setComposerFocusRequest((count) => count + 1);
      }
      await loadConversation(conversationId);
    },
    [conversationId, loadConversation],
  );

  const signOut = useCallback(async () => {
    try {
      await logout();
    } catch {
      // The sign-in page is still the right place to go.
    }
    navigateTo(LOGIN_PATH);
  }, []);

  const connectionsChecked = providers.every((provider) => state.connections[provider] !== null);
  const jobConversation = conversationId && state.kind !== "chat" ? jobConversations[state.kind] : null;
  const readOnly = jobConversation !== null;
  const statusProvider = selection?.provider ?? preferences.provider ?? "ollama";
  const hasPlan = state.plan.length > 0;
  const canSend = selection !== null && state.phase !== "loading" && state.loadError === null;
  const restoreDisabled = running || state.phase === "loading" || readOnly;
  const runningElsewhere = state.running && state.phase === "idle" && conversationId !== null;
  const worktreeBranch = state.workspace?.mode === "worktree" ? state.workspace.branch : null;
  const changeTotals =
    state.changes?.available && state.changes.files.length > 0
      ? { additions: state.changes.additions, deletions: state.changes.deletions }
      : null;
  const showChangesPanel = changesOpen && conversationId !== null && !readOnly;

  let hint = null;
  if (!selection && connectionsChecked) {
    hint = (
      <span className="hint">
        <CircleAlert size={14} aria-hidden="true" />
        <span>
          No model is available yet.{" "}
          <button type="button" className="link-button" onClick={() => setSettingsOpen(true)}>
            Set up a model
          </button>
        </span>
      </span>
    );
  } else if (permissionMode === "full_auto") {
    hint = (
      <span className="hint hint--danger">
        <Zap size={14} aria-hidden="true" />
        <span>Full auto: edits, commands and web requests run without asking.</span>
      </span>
    );
  }

  let placeholder = null;
  if (state.loadError) {
    placeholder = (
      <div className="load-state" role="alert">
        <CircleAlert size={22} aria-hidden="true" />
        <p>{state.loadError}</p>
        <button type="button" className="button button--primary" onClick={newTask}>
          Start a new task
        </button>
      </div>
    );
  } else if (state.phase === "loading") {
    placeholder = (
      <div className="load-state" aria-live="polite">
        <LoaderCircle size={20} aria-hidden="true" className="spin" />
        <p>Loading task…</p>
      </div>
    );
  } else if (!conversationId) {
    placeholder = (
      <EmptyState
        onSuggestion={(text) => {
          setDraft(text);
          inputRef.current?.focus();
        }}
      />
    );
  }

  const title = state.title ?? (conversationId ? "" : "New task");

  return (
    <div className="app">
      <Sidebar
        conversations={state.conversations}
        activeId={conversationId}
        collapsed={preferences.sidebarCollapsed}
        mobileOpen={drawerOpen}
        onCloseMobile={() => setDrawerOpen(false)}
        onToggleCollapsed={() => writePreferences({ sidebarCollapsed: !preferences.sidebarCollapsed })}
        onNewTask={newTask}
        onSelect={openConversation}
        onRename={rename}
        onDelete={remove}
        onOpenSettings={() => {
          setDrawerOpen(false);
          setSettingsOpen(true);
        }}
        onSignOut={session?.remote ? () => void signOut() : undefined}
        provider={statusProvider}
        connection={state.connections[statusProvider]}
      />
      <main className="main">
        <header className="main-header">
          <button
            type="button"
            className="icon-button main-header__menu"
            aria-label="Open sidebar"
            onClick={() => setDrawerOpen(true)}
          >
            <Menu size={19} aria-hidden="true" />
          </button>
          {conversationId ? (
            <h1 className="main-header__title">{title}</h1>
          ) : (
            <span className="main-header__title">{title}</span>
          )}
          {jobConversation && <span className="badge badge--info kind-badge">{jobConversation.badge}</span>}
          {worktreeBranch && (
            <span className="branch-badge" title={`Worktree branch: ${worktreeBranch}`}>
              <GitBranch size={13} aria-hidden="true" />
              <span className="sr-only">Worktree branch: </span>
              <span className="branch-badge__name">{worktreeBranch}</span>
            </span>
          )}
          {hasPlan && (
            <button
              type="button"
              className="plan-toggle"
              aria-pressed={planOpen && !showChangesPanel}
              onClick={() => {
                // The plan rail and the changes panel share the right side.
                if (showChangesPanel) {
                  setChangesOpen(false);
                  setPlanOpen(true);
                } else {
                  setPlanOpen(!planOpen);
                }
              }}
            >
              <ListChecks size={15} aria-hidden="true" />
              Plan
              <span className="plan-progress">{planProgress(state.plan)}</span>
            </button>
          )}
          {conversationId && state.trainingStatus !== null && (
            <TrainingStatusControl value={state.trainingStatus} onChange={changeTrainingStatus} />
          )}
          {conversationId && !readOnly && (
            <button
              ref={changesButtonRef}
              type="button"
              className="changes-toggle"
              aria-expanded={showChangesPanel}
              aria-controls={showChangesPanel ? CHANGES_PANEL_ID : undefined}
              aria-label={
                changeTotals
                  ? `Changes, ${changeTotals.additions} added, ${changeTotals.deletions} removed`
                  : "Changes"
              }
              onClick={showChangesPanel ? closeChanges : openChanges}
            >
              <GitCompare size={15} aria-hidden="true" />
              <span className="changes-toggle__label">Changes</span>
              {changeTotals && <DiffStat additions={changeTotals.additions} deletions={changeTotals.deletions} />}
            </button>
          )}
          <button type="button" className="icon-button main-header__mobile" aria-label="Settings" onClick={() => setSettingsOpen(true)}>
            <Settings size={18} aria-hidden="true" />
          </button>
          <button type="button" className="icon-button main-header__mobile" aria-label="New task" onClick={newTask}>
            <Plus size={19} aria-hidden="true" />
          </button>
        </header>
        <Transcript
          messages={state.messages}
          running={running}
          error={state.error}
          stepLimitReached={state.stepLimitReached}
          onRetry={resume}
          onDismissError={() => dispatch({ type: "dismiss_error" })}
          onDecision={decide}
          approvalsDisabled={running || !selection || readOnly}
          placeholder={placeholder}
          checkpoints={state.checkpoints}
          subagents={state.subagents}
          onRestore={readOnly ? undefined : requestRestore}
          restoreDisabled={restoreDisabled}
          feedback={state.feedback}
          onFeedback={conversationId && state.phase !== "loading" ? giveFeedback : undefined}
          showModels={selection?.auto === true}
          readOnly={readOnly}
        />
        <div className="composer-dock">
          {jobConversation && (
            <div className="banner banner--info banner--job" role="note">
              <FlaskConical size={15} aria-hidden="true" className="banner__icon" />
              <span className="banner__text">{jobConversation.text}</span>
              <Link href={jobConversation.href} className="button button--secondary button--small">
                Open Training
              </Link>
            </div>
          )}
          {runningElsewhere && !readOnly && (
            <div className="banner banner--info banner--running" role="status">
              <LoaderCircle size={15} aria-hidden="true" className="spin banner__icon" />
              <span className="banner__text">This task is still running in another tab or session.</span>
              <button
                type="button"
                className="button button--secondary button--small"
                onClick={() => void loadConversation(conversationId)}
              >
                <RefreshCw size={14} aria-hidden="true" />
                Refresh
              </button>
            </div>
          )}
          {notice && (
            <div className="notice" role="status">
              <CircleCheck size={15} aria-hidden="true" className="notice__icon" />
              <span className="notice__text">{notice}</span>
              <button type="button" className="icon-button" aria-label="Dismiss" onClick={() => setNotice(null)}>
                <X size={14} aria-hidden="true" />
              </button>
            </div>
          )}
          {hasPlan && <PlanBar plan={state.plan} />}
          {!readOnly && (
            <Composer
              value={draft}
              onChange={setDraft}
              onSend={send}
              onStop={stop}
              running={running}
              canSend={canSend}
              hint={hint}
              inputRef={inputRef}
              toolbar={
                <>
                  <ModelPicker
                    connections={state.connections}
                    selection={selection}
                    onSelect={selectModel}
                    onRecheck={checkConnections}
                    router={router}
                    onSelectAuto={selectAuto}
                  />
                  <ModePicker mode={permissionMode} onChange={selectMode} />
                  {offerIsolation && (
                    <IsolationToggle value={preferences.isolation} onChange={selectIsolation} disabled={running} />
                  )}
                </>
              }
            />
          )}
        </div>
      </main>
      {hasPlan && planOpen && !showChangesPanel && <PlanPanel plan={state.plan} onClose={() => setPlanOpen(false)} />}
      {showChangesPanel && (
        <ChangesPanel
          id={CHANGES_PANEL_ID}
          conversationId={conversationId}
          title={state.title || "Changes from Tatvam"}
          changes={state.changes}
          error={state.changesError}
          checkpoints={state.checkpoints}
          busy={running}
          onClose={closeChanges}
          onRefresh={() => refreshChanges(conversationId)}
          onGitDone={onGitDone}
          onRestore={requestRestore}
        />
      )}
      {restoreTarget && (
        <RestoreDialog
          checkpoint={restoreTarget.checkpoint}
          allowRewind={restoreTarget.allowRewind}
          onConfirm={(rewind) => confirmRestore(restoreTarget.checkpoint, rewind)}
          onClose={() => setRestoreTarget(null)}
        />
      )}
      {settingsOpen && (
        <SettingsDialog
          onClose={() => setSettingsOpen(false)}
          connections={state.connections}
          onRecheck={checkConnections}
        />
      )}
    </div>
  );
}
