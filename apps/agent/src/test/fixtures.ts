import type {
  CheckpointView,
  ConversationDetail,
  DatasetExportView,
  DiffFile,
  DistillJobView,
  EvalRunView,
  EvalSuiteView,
  EvalTaskResult,
  FeedbackView,
  FinetuneKitView,
  GitChanges,
  ModelConnection,
  RegisteredModel,
  RouterConfig,
  SubagentView,
  TrainingConversationView,
  WorkspaceInfo,
} from "@/lib/contract";

// Shared builders for browser-side tests. Every builder takes overrides so a test states only what it checks.

export const NOW = "2026-10-10T12:00:00.000Z";

export const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

export function workspaceInfo(overrides: Partial<WorkspaceInfo> = {}): WorkspaceInfo {
  return {
    mode: "shared",
    path: "/workspace",
    isGitRepo: true,
    branch: "main",
    baseBranch: null,
    baseCommit: "abc1234",
    ...overrides,
  };
}

export function conversationDetail(
  overrides: Partial<ConversationDetail> & Pick<ConversationDetail, "id">,
): ConversationDetail {
  return {
    title: "Fix the parser",
    createdAt: NOW,
    updatedAt: NOW,
    messages: [],
    plan: [],
    permissionMode: "ask",
    provider: "ollama",
    model: "qwen3",
    allowedTools: [],
    workspace: workspaceInfo(),
    checkpoints: [],
    subagents: [],
    running: false,
    kind: "chat",
    trainingStatus: "unreviewed",
    feedback: [],
    ...overrides,
  };
}

export function checkpointView(overrides: Partial<CheckpointView> = {}): CheckpointView {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    kind: "turn",
    label: "Before: Fix the parser",
    messageId: "u1",
    toolCallId: null,
    createdAt: NOW,
    ...overrides,
  };
}

export function subagentView(overrides: Partial<SubagentView> = {}): SubagentView {
  return {
    id: "sub-1",
    toolCallId: "call-delegate",
    role: "researcher",
    task: "Find how the parser handles escapes",
    status: "running",
    steps: 2,
    activity: "Reading src/parser.ts",
    report: "",
    createdAt: NOW,
    ...overrides,
  };
}

export function diffFile(overrides: Partial<DiffFile> = {}): DiffFile {
  return {
    path: "src/parser.ts",
    oldPath: null,
    status: "modified",
    binary: false,
    additions: 2,
    deletions: 1,
    truncated: false,
    hunks: [
      {
        header: "@@ -10,3 +10,4 @@ function parse()",
        lines: [
          { type: "context", text: "const a = 1;", oldLine: 10, newLine: 10 },
          { type: "del", text: "const b = 2;", oldLine: 11, newLine: null },
          { type: "add", text: "const b = 3;", oldLine: null, newLine: 11 },
          { type: "add", text: "const c = 4;", oldLine: null, newLine: 12 },
          { type: "context", text: "return a;", oldLine: 12, newLine: 13 },
        ],
      },
    ],
    ...overrides,
  };
}

export function gitChanges(overrides: Partial<GitChanges> = {}): GitChanges {
  return {
    available: true,
    workspace: workspaceInfo({ mode: "worktree", branch: "tatvam/fix-parser", baseBranch: "main" }),
    files: [diffFile()],
    additions: 2,
    deletions: 1,
    truncated: false,
    ahead: 2,
    hasUncommitted: true,
    remote: { name: "origin", url: "git@github.com:acme/app.git", webUrl: "https://github.com/acme/app" },
    canOpenPullRequest: true,
    ...overrides,
  };
}

// ── Training loop ───────────────────────────────────────────────────────────

export function readyConnection(provider: ModelConnection["provider"], models: string[]): ModelConnection {
  return { provider, state: "ready", models };
}

export function feedbackView(overrides: Partial<FeedbackView> = {}): FeedbackView {
  return {
    messageId: "55555555-5555-4555-8555-555555555555",
    toolCallId: null,
    rating: null,
    correction: null,
    note: null,
    updatedAt: NOW,
    ...overrides,
  };
}

export function trainingConversation(overrides: Partial<TrainingConversationView> = {}): TrainingConversationView {
  return {
    id: "66666666-6666-4666-8666-666666666666",
    title: "Fix the parser",
    createdAt: NOW,
    updatedAt: NOW,
    kind: "chat",
    trainingStatus: "unreviewed",
    model: "qwen3",
    messageCount: 4,
    toolCallCount: 3,
    upCount: 1,
    downCount: 0,
    correctionCount: 0,
    ...overrides,
  };
}

export function datasetExport(overrides: Partial<DatasetExportView> = {}): DatasetExportView {
  return {
    id: "77777777-7777-4777-8777-777777777777",
    createdAt: NOW,
    request: {
      statuses: ["approved"],
      kinds: ["chat", "distill"],
      requirePositiveFeedback: false,
      redactPii: true,
      evalFraction: 0.1,
      systemPrompt: "agent",
    },
    stats: {
      conversations: 12,
      sftTrain: 40,
      sftEval: 5,
      preferencePairs: 3,
      duplicatesDropped: 2,
      redactions: { api_key: 3, email: 1 },
      skipped: { no_assistant_reply: 2 },
    },
    files: [
      { name: "sft_train.jsonl", bytes: 20480, records: 40 },
      { name: "sft_eval.jsonl", bytes: 2048, records: 5 },
    ],
    ...overrides,
  };
}

export function evalSuite(overrides: Partial<EvalSuiteView> = {}): EvalSuiteView {
  return {
    id: "core",
    title: "Core agent skills",
    description: "Tool use, small coding tasks and following instructions.",
    tasks: [
      { id: "read-file", title: "Read a file", category: "tool_use" },
      { id: "fix-bug", title: "Fix a failing test", category: "coding" },
    ],
    ...overrides,
  };
}

export function evalTaskResult(overrides: Partial<EvalTaskResult> = {}): EvalTaskResult {
  return {
    taskId: "read-file",
    title: "Read a file",
    category: "tool_use",
    status: "passed",
    score: 1,
    steps: 3,
    durationMs: 4200,
    toolCalls: 2,
    invalidToolCalls: 0,
    checks: [{ name: "Used read_file", passed: true, detail: "Called read_file on README.md" }],
    conversationId: "88888888-8888-4888-8888-888888888888",
    ...overrides,
  };
}

export function evalRun(overrides: Partial<EvalRunView> = {}): EvalRunView {
  return {
    id: "99999999-9999-4999-8999-999999999999",
    suiteId: "core",
    target: { provider: "ollama", model: "qwen3" },
    judge: null,
    status: "completed",
    error: null,
    startedAt: NOW,
    finishedAt: NOW,
    summary: {
      total: 2,
      passed: 1,
      failed: 1,
      errors: 0,
      passRate: 0.5,
      toolCallValidity: 0.9,
      avgSteps: 3.5,
      avgDurationMs: 5000,
      byCategory: { tool_use: { total: 1, passed: 1 }, coding: { total: 1, passed: 0 } },
    },
    results: [
      evalTaskResult(),
      evalTaskResult({
        taskId: "fix-bug",
        title: "Fix a failing test",
        category: "coding",
        status: "failed",
        score: 0.5,
        checks: [
          { name: "Tests pass", passed: false, detail: "1 test still fails" },
          { name: "Edited the right file", passed: true, detail: "src/sum.ts" },
        ],
        conversationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      }),
    ],
    ...overrides,
  };
}

export function distillJob(overrides: Partial<DistillJobView> = {}): DistillJobView {
  return {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    teacher: { provider: "gpu", model: "big-teacher" },
    status: "completed",
    error: null,
    total: 2,
    completed: 2,
    failed: 0,
    conversationIds: ["cccccccc-cccc-4ccc-8ccc-cccccccccccc", "dddddddd-dddd-4ddd-8ddd-dddddddddddd"],
    startedAt: NOW,
    finishedAt: NOW,
    ...overrides,
  };
}

export function finetuneKit(overrides: Partial<FinetuneKitView> = {}): FinetuneKitView {
  return {
    id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    createdAt: NOW,
    request: {
      exportId: "77777777-7777-4777-8777-777777777777",
      baseModel: "Qwen/Qwen3-8B",
      method: "sft_lora",
      framework: "trl",
      hyperparameters: {
        epochs: 2,
        learningRate: 0.0002,
        loraRank: 16,
        loraAlpha: 32,
        maxSeqLength: 4096,
        batchSize: 2,
        gradientAccumulation: 8,
      },
      outputName: "tatvam-agent-lora",
    },
    path: "/data/training/kits/tatvam-agent-lora",
    files: [
      { name: "train.py", bytes: 4096 },
      { name: "README.md", bytes: 1024 },
    ],
    instructions: "## Run it\n\n1. Copy the folder to the GPU server.\n2. Run `python train.py`.",
    ...overrides,
  };
}

export function registeredModel(overrides: Partial<RegisteredModel> = {}): RegisteredModel {
  return {
    id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
    provider: "ollama",
    modelId: "qwen3",
    label: "Qwen3 base",
    kind: "base",
    parentId: null,
    datasetExportId: null,
    status: "candidate",
    notes: "",
    createdAt: NOW,
    latestEval: { runId: "99999999-9999-4999-8999-999999999999", suiteId: "core", passRate: 0.5, finishedAt: NOW },
    ...overrides,
  };
}

export function routerConfig(overrides: Partial<RouterConfig> = {}): RouterConfig {
  return { enabled: false, main: null, subagent: null, judge: null, fallback: null, canary: null, ...overrides };
}
