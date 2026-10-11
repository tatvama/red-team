import { z } from "zod";

// Shared between the browser and the server. The browser only ever names a provider and a model;
// upstream URLs and API keys live in server environment variables.

export const providerSchema = z.enum(["ollama", "gpu"]);
export type Provider = z.infer<typeof providerSchema>;
export const providerNames: Record<Provider, string> = { ollama: "Local Ollama", gpu: "GPU server" };

export type ModelConnection = {
  provider: Provider;
  state: "ready" | "offline" | "unconfigured" | "empty";
  models: string[];
};

export const permissionModeSchema = z.enum(["ask", "accept_edits", "plan", "full_auto"]);
export type PermissionMode = z.infer<typeof permissionModeSchema>;
export const permissionModes: Record<PermissionMode, { label: string; description: string }> = {
  ask: {
    label: "Ask before acting",
    description: "Reads run freely. Edits, commands and web requests wait for your approval.",
  },
  accept_edits: {
    label: "Accept edits",
    description: "File edits apply automatically. Commands and web requests still ask.",
  },
  plan: {
    label: "Plan only",
    description: "Read-only. The agent can explore and plan, but cannot edit files or run commands.",
  },
  full_auto: {
    label: "Full auto",
    description: "Everything runs without asking. Use only with a sandboxed workspace.",
  },
};

export const toolPolicySchema = z.enum(["auto", "ask", "off"]);
export type ToolPolicy = z.infer<typeof toolPolicySchema>;
export type ToolRisk = "read" | "write" | "network" | "execute";

/**
 * Pure decision: may this tool run now, must it ask, or is it hidden?
 * The per-tool setting comes first, then the permission mode, then "always allow" grants.
 */
export function effectivePolicy(
  mode: PermissionMode,
  risk: ToolRisk,
  toolPolicy: ToolPolicy,
  alwaysAllowed: boolean,
): ToolPolicy {
  if (toolPolicy === "off") return "off";
  if (mode === "plan" && (risk === "write" || risk === "execute")) return "off";
  if (toolPolicy === "auto") return "auto";
  if (mode === "full_auto" || alwaysAllowed) return "auto";
  if (mode === "accept_edits" && risk === "write") return "auto";
  return "ask";
}

export type ToolCallStatus = "awaiting_approval" | "running" | "ok" | "error" | "denied";

export type ToolCallView = {
  id: string;
  name: string;
  /** Human label, for example "Edit file". Falls back to the tool name for unknown tools. */
  title: string;
  /** Raw JSON arguments exactly as the model produced them. */
  arguments: string;
  /** One line describing this call, for example "Edit src/app.ts". */
  summary: string;
  risk: ToolRisk;
  status: ToolCallStatus;
  output?: string;
};

export type UserMessageView = { id: string; role: "user"; content: string; createdAt: string };
export type AssistantMessageView = {
  id: string;
  role: "assistant";
  content: string;
  reasoning: string;
  toolCalls: ToolCallView[];
  model: string | null;
  interrupted: boolean;
  createdAt: string;
};
/** Tool results are folded into the matching assistant message's `toolCalls`. */
export type MessageView = UserMessageView | AssistantMessageView;

export const planItemSchema = z
  .object({
    step: z.string().trim().min(1).max(300),
    status: z.enum(["pending", "in_progress", "completed"]),
  })
  .strict();
export type PlanItem = z.infer<typeof planItemSchema>;


// ── Workspace, checkpoints and git ───────────────────────────────────────────

export const isolationSchema = z.enum(["shared", "worktree"]);
/** `shared` works directly in WORKSPACE_DIR; `worktree` gives the task its own git worktree and branch. */
export type Isolation = z.infer<typeof isolationSchema>;

export type WorkspaceInfo = {
  mode: Isolation;
  /** Absolute server path, for display only. */
  path: string;
  isGitRepo: boolean;
  /** Branch checked out in this workspace (the task branch for worktrees). */
  branch: string | null;
  /** Branch the worktree was created from, the target for merge and pull requests. */
  baseBranch: string | null;
  /** Commit the task started from; diffs are shown against it. */
  baseCommit: string | null;
};

export type CheckpointView = {
  id: string;
  /** `turn`: taken before the agent handled a user message. `tool`: taken before a file edit or command. */
  kind: "turn" | "tool";
  label: string;
  messageId: string | null;
  toolCallId: string | null;
  createdAt: string;
};

export const restoreCheckpointSchema = z
  .object({
    checkpointId: z.string().uuid(),
    /** Also delete the conversation from this point on. Only valid for `turn` checkpoints. */
    rewindConversation: z.boolean(),
  })
  .strict();
export type RestoreCheckpointRequest = z.infer<typeof restoreCheckpointSchema>;
export type RestoreCheckpointResult = {
  message: string;
  /** The user message removed by a rewind, so the UI can put it back in the composer. */
  restoredPrompt: string | null;
};

export type DiffLine = { type: "add" | "del" | "context"; text: string; oldLine: number | null; newLine: number | null };
export type DiffHunk = { header: string; lines: DiffLine[] };
export type DiffFile = {
  path: string;
  oldPath: string | null;
  status: "added" | "modified" | "deleted" | "renamed";
  binary: boolean;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
  /** True when hunks were cut to keep the response small. */
  truncated: boolean;
};
export type GitChanges = {
  available: boolean;
  /** Why git review is unavailable, for example "The workspace is not a git repository". */
  reason?: string;
  workspace: WorkspaceInfo;
  files: DiffFile[];
  additions: number;
  deletions: number;
  truncated: boolean;
  /** Commits on the task branch that are not on the base branch. */
  ahead: number;
  hasUncommitted: boolean;
  remote: { name: string; url: string; webUrl: string | null } | null;
  /** True when GITHUB_TOKEN is set and the remote is on GitHub. */
  canOpenPullRequest: boolean;
};

export const gitActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("commit"), message: z.string().trim().min(1).max(5000) }).strict(),
  z.object({ action: z.literal("push") }).strict(),
  z
    .object({
      action: z.literal("pull_request"),
      title: z.string().trim().min(1).max(256),
      body: z.string().max(20_000),
      draft: z.boolean(),
    })
    .strict(),
  /** Merge the task branch into its base branch in the main checkout (worktree tasks only). */
  z.object({ action: z.literal("merge") }).strict(),
  /** Remove the task's worktree and delete its branch (worktree tasks only). */
  z.object({ action: z.literal("discard") }).strict(),
]);
export type GitAction = z.infer<typeof gitActionSchema>;
export type GitActionResult = { message: string; url?: string };

// ── Sub-agents ───────────────────────────────────────────────────────────────

export const subagentRoleSchema = z.enum(["researcher", "reviewer", "tester", "general"]);
export type SubagentRole = z.infer<typeof subagentRoleSchema>;
export type SubagentView = {
  id: string;
  toolCallId: string;
  role: SubagentRole;
  task: string;
  status: "running" | "done" | "error" | "stopped";
  steps: number;
  /** What it is doing right now, for example "Reading src/app.ts". */
  activity: string;
  /** Final markdown report (or the error). */
  report: string;
  createdAt: string;
};

// ── Conversations and events ────────────────────────────────────────────────

export type ConversationSummary = { id: string; title: string; createdAt: string; updatedAt: string };
export type ConversationDetail = ConversationSummary & {
  messages: MessageView[];
  plan: PlanItem[];
  permissionMode: PermissionMode;
  provider: Provider | null;
  model: string | null;
  /** Tool names granted "always allow" in this conversation. */
  allowedTools: string[];
  workspace: WorkspaceInfo;
  checkpoints: CheckpointView[];
  subagents: SubagentView[];
  /** True while an agent run for this conversation is in progress (possibly in another tab). */
  running: boolean;
  kind: ConversationKind;
  trainingStatus: TrainingStatus;
  /** Ratings and corrections on this conversation's replies and tool calls. */
  feedback: FeedbackView[];
};

/** Newline-delimited JSON events streamed by POST /api/agent and POST /api/agent/approve. */
export type AgentEvent =
  | { type: "conversation"; conversation: ConversationSummary }
  | { type: "message"; message: MessageView }
  | { type: "reasoning"; messageId: string; text: string }
  | { type: "token"; messageId: string; text: string }
  | { type: "tool_call"; messageId: string; call: ToolCallView }
  | { type: "tool_result"; messageId: string; callId: string; status: ToolCallStatus; output: string }
  | { type: "plan"; plan: PlanItem[] }
  | { type: "subagent"; messageId: string; subagent: SubagentView }
  | { type: "checkpoint"; checkpoint: CheckpointView }
  | { type: "done"; reason: "complete" | "awaiting_approval" | "max_steps" | "stopped" }
  | { type: "error"; message: string };

const id = z.string().uuid();

export const agentRequestSchema = z
  .object({
    conversationId: id.optional(),
    provider: providerSchema,
    model: z.string().trim().min(1).max(200),
    permissionMode: permissionModeSchema,
    /** Omit to resume an existing conversation, for example after a stop or an error. */
    content: z.string().trim().min(1).max(100_000).optional(),
    /** Only used when a new conversation is created. Defaults to `shared`. */
    isolation: isolationSchema.optional(),
    /** Let the server's model router pick the model (see `routerConfigSchema`); provider and model are the fallback. */
    useRouter: z.boolean().optional(),
  })
  .strict()
  .refine((data) => data.content !== undefined || data.conversationId !== undefined, {
    message: "Send a message or choose a conversation to continue",
  });
export type AgentRequest = z.infer<typeof agentRequestSchema>;

export const approvalRequestSchema = z
  .object({
    conversationId: id,
    callId: z.string().min(1).max(200),
    decision: z.enum(["approve", "deny", "approve_always"]),
    provider: providerSchema,
    model: z.string().trim().min(1).max(200),
    permissionMode: permissionModeSchema,
    /** Continue on the model the router assigned to this conversation. */
    useRouter: z.boolean().optional(),
  })
  .strict();
export type ApprovalRequest = z.infer<typeof approvalRequestSchema>;

export const renameSchema = z.object({ title: z.string().trim().min(1).max(120) }).strict();

/** Tool names: lowercase letters, digits and underscores. MCP tools are named `mcp_<server>_<tool>`. */
export const toolNamePattern = /^[a-z0-9_]{1,64}$/;

export const settingsUpdateSchema = z
  .object({
    instructions: z.string().max(4000),
    toolPolicies: z.record(z.string().regex(toolNamePattern), toolPolicySchema),
  })
  .strict();
export type SettingsUpdate = z.infer<typeof settingsUpdateSchema>;

export type ToolInfo = {
  name: string;
  title: string;
  description: string;
  risk: ToolRisk;
  defaultPolicy: ToolPolicy;
  policy: ToolPolicy;
  available: boolean;
  /** Why the tool is unavailable, for example "Set BRAVE_API_KEY, TAVILY_API_KEY or SEARXNG_URL". */
  reason?: string;
  /** `builtin`, or the MCP server name the tool comes from. */
  source: "builtin" | { mcpServer: string };
};
export type Memory = { id: string; text: string; createdAt: string };

export type McpServerView = {
  name: string;
  transport: "stdio" | "http";
  /** Command or URL, with secrets removed, for display. */
  target: string;
  enabled: boolean;
  status: "connected" | "connecting" | "error" | "disabled";
  error?: string;
  tools: { name: string; title: string; description: string }[];
};
export const mcpActionSchema = z.object({ action: z.enum(["enable", "disable", "restart"]) }).strict();

export type SettingsView = {
  instructions: string;
  tools: ToolInfo[];
  memories: Memory[];
  workspaceDir: string;
  commandRunner: "off" | "docker" | "host";
  mcpServers: McpServerView[];
  /** Where MCP servers are configured (servers cannot be added from the browser). */
  mcpConfigPath: string;
};

/** GET /api/workspace: the default workspace, so the composer can offer worktree isolation. */
export type DefaultWorkspaceView = { path: string; isGitRepo: boolean; branch: string | null };

// ── Access ──────────────────────────────────────────────────────────────────

export const loginSchema = z.object({ token: z.string().min(1).max(500) }).strict();
/** GET /api/auth/session. `remote` is true when the app is reached through a non-loopback host. */
export type SessionView = { remote: boolean; authenticated: boolean };

// ── Training loop: feedback, datasets, evaluations, distillation, fine-tuning, models ──────────

export const conversationKindSchema = z.enum(["chat", "eval", "distill"]);
/** `eval` and `distill` conversations are created by background jobs and hidden from the sidebar. */
export type ConversationKind = z.infer<typeof conversationKindSchema>;
export const trainingStatusSchema = z.enum(["unreviewed", "approved", "excluded"]);
/** Only `approved` conversations go into datasets by default. */
export type TrainingStatus = z.infer<typeof trainingStatusSchema>;

export type FeedbackView = {
  messageId: string;
  /** Set when the feedback is about one tool call rather than the whole reply. */
  toolCallId: string | null;
  rating: "up" | "down" | null;
  /** A better reply written by the user; becomes the training target (and the DPO "chosen" side). */
  correction: string | null;
  note: string | null;
  updatedAt: string;
};
/** PUT /api/conversations/:id/feedback. Setting rating, correction and note all to null clears it. */
export const feedbackSchema = z
  .object({
    messageId: z.string().uuid(),
    toolCallId: z.string().min(1).max(200).nullable(),
    rating: z.enum(["up", "down"]).nullable(),
    correction: z.string().max(50_000).nullable(),
    note: z.string().max(2000).nullable(),
  })
  .strict();
export type FeedbackRequest = z.infer<typeof feedbackSchema>;
/** PUT /api/conversations/:id/training. */
export const trainingStatusUpdateSchema = z.object({ trainingStatus: trainingStatusSchema }).strict();

/** GET /api/training/conversations?status=&kind= (the review queue). */
export type TrainingConversationView = ConversationSummary & {
  kind: ConversationKind;
  trainingStatus: TrainingStatus;
  model: string | null;
  messageCount: number;
  toolCallCount: number;
  upCount: number;
  downCount: number;
  correctionCount: number;
};

export const datasetExportRequestSchema = z
  .object({
    statuses: z.array(trainingStatusSchema).min(1).max(3),
    kinds: z.array(conversationKindSchema).min(1).max(3),
    /** Keep only conversations with at least one thumbs-up and no thumbs-down without a correction. */
    requirePositiveFeedback: z.boolean(),
    /** Also mask emails, phone numbers and IP addresses (secrets are always masked). */
    redactPii: z.boolean(),
    /** Share of examples held out for evaluation, split deterministically by content hash. */
    evalFraction: z.number().min(0).max(0.5),
    /** `agent`: the tool-using system prompt Tatvam uses. `minimal`: a one-line assistant prompt. */
    systemPrompt: z.enum(["agent", "minimal"]),
  })
  .strict();
export type DatasetExportRequest = z.infer<typeof datasetExportRequestSchema>;
export type DatasetExportView = {
  id: string;
  createdAt: string;
  request: DatasetExportRequest;
  stats: {
    conversations: number;
    sftTrain: number;
    sftEval: number;
    preferencePairs: number;
    duplicatesDropped: number;
    /** Masked values by kind, for example { "api_key": 3, "email": 1 }. */
    redactions: Record<string, number>;
    /** Conversations left out, by reason. */
    skipped: Record<string, number>;
  };
  files: { name: string; bytes: number; records: number }[];
};

export const evalCategorySchema = z.enum(["tool_use", "coding", "research", "instructions", "safety"]);
export type EvalCategory = z.infer<typeof evalCategorySchema>;
export type EvalSuiteView = {
  id: string;
  title: string;
  description: string;
  tasks: { id: string; title: string; category: EvalCategory }[];
};
export const modelRefSchema = z.object({ provider: providerSchema, model: z.string().trim().min(1).max(200) }).strict();
export type ModelRef = z.infer<typeof modelRefSchema>;
export const evalRunRequestSchema = z
  .object({
    suiteId: z.string().regex(/^[a-z0-9-]{1,60}$/),
    target: modelRefSchema,
    /** Optional model that grades free-form answers against each task's rubric. */
    judge: modelRefSchema.nullable(),
    /** Run a subset; omit for the whole suite. */
    taskIds: z.array(z.string().regex(/^[a-z0-9-]{1,60}$/)).min(1).max(200).optional(),
  })
  .strict();
export type EvalRunRequest = z.infer<typeof evalRunRequestSchema>;
export type EvalCheckResult = { name: string; passed: boolean; detail: string };
export type EvalTaskResult = {
  taskId: string;
  title: string;
  category: EvalCategory;
  status: "pending" | "running" | "passed" | "failed" | "error";
  /** 0 to 1: the share of checks passed (or the judge's grade). */
  score: number;
  steps: number;
  durationMs: number;
  toolCalls: number;
  /** Calls with unknown tools, invalid JSON or arguments that failed validation. */
  invalidToolCalls: number;
  checks: EvalCheckResult[];
  conversationId: string | null;
};
export type JobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type EvalRunView = {
  id: string;
  suiteId: string;
  target: ModelRef;
  judge: ModelRef | null;
  status: JobStatus;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  summary: {
    total: number;
    passed: number;
    failed: number;
    errors: number;
    passRate: number;
    /** Valid tool calls divided by all tool calls. */
    toolCallValidity: number;
    avgSteps: number;
    avgDurationMs: number;
    byCategory: Partial<Record<EvalCategory, { total: number; passed: number }>>;
  };
  results: EvalTaskResult[];
};

export const distillRequestSchema = z
  .object({
    teacher: modelRefSchema,
    source: z.discriminatedUnion("type", [
      z.object({ type: z.literal("prompts"), prompts: z.array(z.string().trim().min(1).max(8000)).min(1).max(200) }).strict(),
      /** Re-ask the first user message of recent chat conversations. */
      z.object({ type: z.literal("history"), limit: z.number().int().min(1).max(500) }).strict(),
    ]),
    /** Mark the teacher's conversations approved for training straight away. */
    autoApprove: z.boolean(),
  })
  .strict();
export type DistillRequest = z.infer<typeof distillRequestSchema>;
export type DistillJobView = {
  id: string;
  teacher: ModelRef;
  status: JobStatus;
  error: string | null;
  total: number;
  completed: number;
  failed: number;
  conversationIds: string[];
  startedAt: string;
  finishedAt: string | null;
};

export const finetuneKitRequestSchema = z
  .object({
    exportId: z.string().uuid(),
    /** Hugging Face repo id or local path of the base model. */
    baseModel: z.string().trim().min(1).max(200).regex(/^[\w./:-]+$/),
    method: z.enum(["sft_lora", "sft_qlora", "dpo_lora"]),
    framework: z.enum(["trl", "axolotl"]),
    hyperparameters: z
      .object({
        epochs: z.number().min(0.1).max(20),
        learningRate: z.number().gt(0).max(0.01),
        loraRank: z.number().int().min(4).max(256),
        loraAlpha: z.number().int().min(4).max(512),
        maxSeqLength: z.number().int().min(512).max(131_072),
        batchSize: z.number().int().min(1).max(256),
        gradientAccumulation: z.number().int().min(1).max(256),
      })
      .strict(),
    /** Name for the adapter and the merged model. */
    outputName: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
  })
  .strict();
export type FinetuneKitRequest = z.infer<typeof finetuneKitRequestSchema>;
export type FinetuneKitView = {
  id: string;
  createdAt: string;
  request: FinetuneKitRequest;
  /** Absolute server folder holding the kit, to copy to the GPU server. */
  path: string;
  files: { name: string; bytes: number }[];
  /** Markdown: how to run it, step by step. */
  instructions: string;
};

export const modelKindSchema = z.enum(["base", "finetune", "distilled"]);
export const modelStatusSchema = z.enum(["candidate", "active", "retired"]);
export type RegisteredModel = {
  id: string;
  provider: Provider;
  modelId: string;
  label: string;
  kind: z.infer<typeof modelKindSchema>;
  parentId: string | null;
  datasetExportId: string | null;
  status: z.infer<typeof modelStatusSchema>;
  notes: string;
  createdAt: string;
  /** The latest completed eval run for this provider and model. */
  latestEval: { runId: string; suiteId: string; passRate: number; finishedAt: string } | null;
};
export const registerModelSchema = z
  .object({
    provider: providerSchema,
    modelId: z.string().trim().min(1).max(200),
    label: z.string().trim().min(1).max(120),
    kind: modelKindSchema,
    parentId: z.string().uuid().nullable(),
    datasetExportId: z.string().uuid().nullable(),
    status: modelStatusSchema,
    notes: z.string().max(4000),
  })
  .strict();
export const updateModelSchema = registerModelSchema.partial().strict();

/**
 * GET/PUT /api/router. With `enabled`, requests sent with `useRouter: true` run on `main`, except
 * that a `canary.percent` share of new conversations go to the canary model. Sub-agents use
 * `subagent` when set, evaluation judges default to `judge`, and `fallback` answers when the
 * primary model is unreachable or fails with a server error.
 */
export const routerConfigSchema = z
  .object({
    enabled: z.boolean(),
    main: modelRefSchema.nullable(),
    subagent: modelRefSchema.nullable(),
    judge: modelRefSchema.nullable(),
    fallback: modelRefSchema.nullable(),
    canary: z.object({ model: modelRefSchema, percent: z.number().int().min(1).max(50) }).strict().nullable(),
  })
  .strict();
export type RouterConfig = z.infer<typeof routerConfigSchema>;
