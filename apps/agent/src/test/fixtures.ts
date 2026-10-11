import type {
  CheckpointView,
  ConversationDetail,
  DiffFile,
  GitChanges,
  SubagentView,
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
