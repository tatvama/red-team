import type {
  AgentEvent,
  AssistantMessageView,
  CheckpointView,
  ConversationDetail,
  ConversationSummary,
  GitChanges,
  MessageView,
  ModelConnection,
  PlanItem,
  Provider,
  SubagentView,
  ToolCallView,
  UserMessageView,
  WorkspaceInfo,
} from "@/lib/contract";
import type { Preferences } from "./storage";

export type Phase = "idle" | "loading" | "streaming";

export type InlineError = {
  message: string;
  /** True when the conversation exists on the server, so resuming it can help. */
  retryable: boolean;
};

export type AgentState = {
  conversationId: string | null;
  title: string | null;
  messages: MessageView[];
  plan: PlanItem[];
  phase: Phase;
  /** Identifies the run that owns `phase === "streaming"`, so a late end from an older run is ignored. */
  runId: number;
  error: InlineError | null;
  /** The last run paused at the per-turn step limit and can be continued. */
  stepLimitReached: boolean;
  /** The selected conversation could not be loaded. */
  loadError: string | null;
  /** Local id of the optimistic user message waiting for its server echo. */
  pendingUserMessageId: string | null;
  /** Where the conversation works; null until it is loaded. */
  workspace: WorkspaceInfo | null;
  /** Restore points, oldest first. */
  checkpoints: CheckpointView[];
  /** Sub-agents started by `delegate_tasks`, from the loaded detail plus live events. */
  subagents: SubagentView[];
  /** The server reported a run in progress at the last load (possibly in another tab or session). */
  running: boolean;
  /** Git review data for the conversation; null until loaded. */
  changes: GitChanges | null;
  /** Why the last changes request failed. */
  changesError: string | null;
  conversations: ConversationSummary[];
  connections: Record<Provider, ModelConnection | null>;
};

export type AgentAction =
  | { type: "event"; event: AgentEvent }
  | { type: "new_task" }
  | { type: "load_start"; conversationId: string }
  | { type: "conversation_loaded"; conversation: ConversationDetail }
  | { type: "load_failure"; conversationId: string; message: string }
  /** Optimistically shows the user's message and starts a run. */
  | { type: "send"; runId: number; message: UserMessageView }
  /** The server rejected a new message before streaming; the message was not saved. */
  | { type: "send_failure"; runId: number; message: string }
  /** Starts a run without a new message: retry, continue or an approval decision. */
  | { type: "run_start"; runId: number }
  | { type: "run_failure"; runId: number; message: string }
  | { type: "run_end"; runId: number; stopped: boolean }
  | { type: "dismiss_error" }
  | { type: "conversations_loaded"; conversations: ConversationSummary[] }
  | { type: "conversation_renamed"; conversation: ConversationSummary }
  | { type: "conversation_deleted"; conversationId: string }
  | { type: "connection_loaded"; connection: ModelConnection }
  | { type: "changes_loaded"; conversationId: string; changes: GitChanges }
  | { type: "changes_failure"; conversationId: string; message: string };

const emptyConversation = {
  conversationId: null,
  title: null,
  messages: [],
  plan: [],
  phase: "idle",
  error: null,
  stepLimitReached: false,
  loadError: null,
  pendingUserMessageId: null,
  workspace: null,
  checkpoints: [],
  subagents: [],
  running: false,
  changes: null,
  changesError: null,
} satisfies Omit<AgentState, "runId" | "conversations" | "connections">;

export function createInitialState(conversationId: string | null): AgentState {
  return {
    ...emptyConversation,
    conversationId,
    phase: conversationId ? "loading" : "idle",
    runId: 0,
    conversations: [],
    connections: { ollama: null, gpu: null },
  };
}

function upsertById<T extends { id: string }>(items: T[], item: T): T[] {
  const index = items.findIndex((existing) => existing.id === item.id);
  if (index === -1) return [...items, item];
  return items.map((existing, i) => (i === index ? item : existing));
}

function updateAssistant(
  messages: MessageView[],
  id: string,
  update: (message: AssistantMessageView) => AssistantMessageView,
): MessageView[] {
  const index = messages.findIndex((message) => message.id === id && message.role === "assistant");
  if (index === -1) return messages;
  return messages.map((message, i) => (i === index && message.role === "assistant" ? update(message) : message));
}

function updateToolCall(
  calls: ToolCallView[],
  callId: string,
  update: (call: ToolCallView) => ToolCallView,
): ToolCallView[] {
  return calls.map((call) => (call.id === callId ? update(call) : call));
}

function applyEvent(state: AgentState, event: AgentEvent): AgentState {
  switch (event.type) {
    case "conversation":
      return {
        ...state,
        conversationId: event.conversation.id,
        title: event.conversation.title,
        conversations: [event.conversation, ...state.conversations.filter((c) => c.id !== event.conversation.id)],
      };
    case "message": {
      const { message } = event;
      if (message.role === "user" && state.pendingUserMessageId) {
        const pendingId = state.pendingUserMessageId;
        const replaced = state.messages.some((m) => m.id === pendingId);
        return {
          ...state,
          pendingUserMessageId: null,
          messages: replaced
            ? state.messages.map((m) => (m.id === pendingId ? message : m))
            : upsertById(state.messages, message),
        };
      }
      return { ...state, messages: upsertById(state.messages, message) };
    }
    case "reasoning":
      return {
        ...state,
        messages: updateAssistant(state.messages, event.messageId, (m) => ({ ...m, reasoning: m.reasoning + event.text })),
      };
    case "token":
      return {
        ...state,
        messages: updateAssistant(state.messages, event.messageId, (m) => ({ ...m, content: m.content + event.text })),
      };
    case "tool_call":
      return {
        ...state,
        messages: updateAssistant(state.messages, event.messageId, (m) => ({
          ...m,
          toolCalls: upsertById(m.toolCalls, event.call),
        })),
      };
    case "tool_result":
      return {
        ...state,
        messages: updateAssistant(state.messages, event.messageId, (m) => ({
          ...m,
          toolCalls: updateToolCall(m.toolCalls, event.callId, (call) => ({
            ...call,
            status: event.status,
            output: event.output,
          })),
        })),
      };
    case "plan":
      return { ...state, plan: event.plan };
    case "subagent":
      return { ...state, subagents: upsertById(state.subagents, event.subagent) };
    case "checkpoint":
      // Appends; a repeat of a known checkpoint replaces it instead of duplicating it.
      return { ...state, checkpoints: upsertById(state.checkpoints, event.checkpoint) };
    case "done":
      return {
        ...state,
        phase: state.phase === "streaming" ? "idle" : state.phase,
        stepLimitReached: event.reason === "max_steps",
      };
    case "error":
      return {
        ...state,
        phase: state.phase === "streaming" ? "idle" : state.phase,
        error: { message: event.message, retryable: state.conversationId !== null },
      };
  }
}

function markLastAssistantInterrupted(messages: MessageView[]): MessageView[] {
  const last = messages.at(-1);
  if (!last || last.role !== "assistant" || last.interrupted) return messages;
  return [...messages.slice(0, -1), { ...last, interrupted: true }];
}

export function agentReducer(state: AgentState, action: AgentAction): AgentState {
  switch (action.type) {
    case "event":
      return applyEvent(state, action.event);
    case "new_task":
      return { ...state, ...emptyConversation };
    case "load_start":
      return { ...state, ...emptyConversation, conversationId: action.conversationId, phase: "loading" };
    case "conversation_loaded": {
      const { conversation } = action;
      // A refetch must never clobber another conversation or a run that started meanwhile.
      if (conversation.id !== state.conversationId || state.phase === "streaming") return state;
      return {
        ...state,
        title: conversation.title,
        messages: conversation.messages,
        plan: conversation.plan,
        workspace: conversation.workspace,
        checkpoints: conversation.checkpoints,
        subagents: conversation.subagents,
        running: conversation.running,
        phase: "idle",
        loadError: null,
        pendingUserMessageId: null,
        conversations: state.conversations.map((c) =>
          c.id === conversation.id ? { ...c, title: conversation.title, updatedAt: conversation.updatedAt } : c,
        ),
      };
    }
    case "load_failure":
      if (action.conversationId !== state.conversationId || state.phase !== "loading") return state;
      return { ...state, phase: "idle", loadError: action.message };
    case "send":
      return {
        ...state,
        phase: "streaming",
        runId: action.runId,
        running: false,
        error: null,
        stepLimitReached: false,
        pendingUserMessageId: action.message.id,
        messages: [...state.messages, action.message],
      };
    case "send_failure":
      if (action.runId !== state.runId) return state;
      return {
        ...state,
        phase: "idle",
        error: { message: action.message, retryable: false },
        messages: state.messages.filter((m) => m.id !== state.pendingUserMessageId),
        pendingUserMessageId: null,
      };
    case "run_start":
      return { ...state, phase: "streaming", runId: action.runId, running: false, error: null, stepLimitReached: false };
    case "run_failure":
      if (action.runId !== state.runId) return state;
      return {
        ...state,
        phase: state.phase === "streaming" ? "idle" : state.phase,
        error: { message: action.message, retryable: state.conversationId !== null },
      };
    case "run_end":
      if (action.runId !== state.runId || state.phase !== "streaming") return state;
      return {
        ...state,
        phase: "idle",
        messages: action.stopped ? markLastAssistantInterrupted(state.messages) : state.messages,
      };
    case "dismiss_error":
      return { ...state, error: null, stepLimitReached: false };
    case "conversations_loaded":
      return { ...state, conversations: action.conversations };
    case "conversation_renamed":
      return {
        ...state,
        title: action.conversation.id === state.conversationId ? action.conversation.title : state.title,
        conversations: state.conversations.map((c) => (c.id === action.conversation.id ? action.conversation : c)),
      };
    case "conversation_deleted":
      return { ...state, conversations: state.conversations.filter((c) => c.id !== action.conversationId) };
    case "connection_loaded":
      return { ...state, connections: { ...state.connections, [action.connection.provider]: action.connection } };
    case "changes_loaded":
      if (action.conversationId !== state.conversationId) return state;
      return { ...state, changes: action.changes, changesError: null };
    case "changes_failure":
      if (action.conversationId !== state.conversationId) return state;
      return { ...state, changesError: action.message };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isString = (value: unknown): value is string => typeof value === "string";

/** Shape check for one streamed line; anything unexpected is dropped rather than crashing the view. */
export function parseAgentEvent(value: unknown): AgentEvent | null {
  if (!isRecord(value)) return null;
  const valid = (() => {
    switch (value.type) {
      case "conversation":
        return isRecord(value.conversation) && isString(value.conversation.id) && isString(value.conversation.title);
      case "message":
        return (
          isRecord(value.message) &&
          isString(value.message.id) &&
          (value.message.role === "user" ||
            (value.message.role === "assistant" && Array.isArray(value.message.toolCalls)))
        );
      case "reasoning":
      case "token":
        return isString(value.messageId) && isString(value.text);
      case "tool_call":
        return isString(value.messageId) && isRecord(value.call) && isString(value.call.id);
      case "tool_result":
        return isString(value.messageId) && isString(value.callId) && isString(value.status) && isString(value.output);
      case "plan":
        return Array.isArray(value.plan);
      case "subagent":
        return (
          isString(value.messageId) &&
          isRecord(value.subagent) &&
          isString(value.subagent.id) &&
          isString(value.subagent.toolCallId)
        );
      case "checkpoint":
        return isRecord(value.checkpoint) && isString(value.checkpoint.id) && isString(value.checkpoint.kind);
      case "done":
        return isString(value.reason);
      case "error":
        return isString(value.message);
      default:
        return false;
    }
  })();
  return valid ? (value as AgentEvent) : null;
}

export type ModelSelection = { provider: Provider; model: string };

/**
 * The model to use: the stored choice while its server lists it, otherwise the first available model,
 * preferring the stored provider. Null when no connected server has a model.
 */
export function resolveModel(
  preferences: Pick<Preferences, "provider" | "model">,
  connections: Record<Provider, ModelConnection | null>,
): ModelSelection | null {
  const { provider, model } = preferences;
  if (provider && model) {
    const connection = connections[provider];
    if (connection?.state === "ready" && connection.models.includes(model)) return { provider, model };
  }
  const order: Provider[] = provider === "gpu" ? ["gpu", "ollama"] : ["ollama", "gpu"];
  for (const candidate of order) {
    const connection = connections[candidate];
    const first = connection?.state === "ready" ? connection.models[0] : undefined;
    if (first) return { provider: candidate, model: first };
  }
  return null;
}
