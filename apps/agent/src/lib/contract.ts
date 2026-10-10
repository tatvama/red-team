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
