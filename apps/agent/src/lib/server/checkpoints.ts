import "server-only";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { CheckpointView, RestoreCheckpointRequest, RestoreCheckpointResult } from "@/lib/contract";
import { dataDir, defaultWorkspaceDir } from "./config";
import {
  addCheckpointRecord,
  deleteCheckpointsAfter,
  deleteMessagesFrom,
  getCheckpointRecord,
  listCheckpointRecords,
  listMessages,
  type CheckpointRecord,
  type ConversationRow,
} from "./db";
import { isConversationId, runGit, withConversationLock } from "./git";

// Checkpoints are commits in a separate "shadow" repository per conversation, run with
// `--git-dir=<shadow> --work-tree=<workspace>`. The user's own repository, index and branches are
// never read or written; the workspace's .gitignore files still decide what is snapshotted.

/** A failure whose message is safe to show the user. */
export class CheckpointError extends Error {
  override name = "CheckpointError";
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 409,
  ) {
    super(message);
  }
}

const SHADOW_EXCLUDES = ["node_modules/", ".next/", "dist/", "build/", ".venv/", "__pycache__/", ".turbo/", "coverage/", "*.log"];
// info/attributes outranks every .gitattributes file, so snapshots hold the bytes exactly as they
// are on disk: no line-ending conversion and no clean/smudge filters (such as Git LFS).
const SHADOW_ATTRIBUTES = "* -text -eol -filter -ident -working-tree-encoding\n";
const SHADOW_CONFIG = `
[core]
\tbare = false
\tautocrlf = false
\tsafecrlf = false
\tquotePath = false
\tlongpaths = true
[user]
\tname = Tatvam checkpoints
\temail = checkpoints@tatvam.invalid
[commit]
\tgpgsign = false
[gc]
\tauto = 0
[maintenance]
\tauto = false
`;
const SNAPSHOT_TIMEOUT_MS = 120_000;

function shadowDir(conversationId: string): string {
  if (!isConversationId(conversationId)) throw new CheckpointError("Invalid conversation id.", 400);
  return path.join(dataDir(), "checkpoints", `${conversationId}.git`);
}

async function isDirectory(dir: string): Promise<boolean> {
  return (await fs.stat(dir).catch(() => null))?.isDirectory() ?? false;
}

function shadowGit(shadow: string, workspace: string, args: string[]) {
  return runGit(args, {
    cwd: workspace,
    globalArgs: [`--git-dir=${shadow}`, `--work-tree=${workspace}`],
    timeoutMs: SNAPSHOT_TIMEOUT_MS,
  });
}

/** Creates the shadow repository once. It is built in a temporary folder and renamed into place. */
async function ensureShadow(shadow: string): Promise<void> {
  if (await fs.stat(path.join(shadow, "HEAD")).catch(() => null)) return;
  const parent = path.dirname(shadow);
  await fs.mkdir(parent, { recursive: true });
  const staging = `${shadow}.tmp-${randomUUID()}`;
  try {
    // `--template=` copies no sample hooks and ignores any init.templateDir.
    const init = await runGit(["init", "--quiet", "--bare", "--template=", "--initial-branch=checkpoints", staging], { cwd: parent });
    if (init.code !== 0) throw new Error("git init failed");
    await fs.appendFile(path.join(staging, "config"), SHADOW_CONFIG, "utf8");
    await fs.mkdir(path.join(staging, "info"), { recursive: true });
    await fs.writeFile(path.join(staging, "info", "exclude"), `${SHADOW_EXCLUDES.join("\n")}\n`, "utf8");
    await fs.writeFile(path.join(staging, "info", "attributes"), SHADOW_ATTRIBUTES, "utf8");
    await fs.rename(staging, shadow);
  } finally {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

/** Commits the workspace as it is now and returns the commit sha. Throws on failure. */
async function snapshot(shadow: string, workspace: string, label: string): Promise<string> {
  await ensureShadow(shadow);
  // --ignore-errors: one unreadable file (for example locked by another program) must not lose the rest.
  await shadowGit(shadow, workspace, ["add", "-A", "--ignore-errors"]);
  const message = label.replace(/\s+/g, " ").trim().slice(0, 200) || "Checkpoint";
  const commit = await shadowGit(shadow, workspace, ["commit", "--quiet", "--allow-empty", "--no-verify", `--message=${message}`]);
  if (commit.code !== 0) throw new Error("snapshot commit failed");
  const head = await shadowGit(shadow, workspace, ["rev-parse", "--verify", "HEAD"]);
  const sha = head.stdout.trim();
  if (head.code !== 0 || !/^[0-9a-f]{40,64}$/.test(sha)) throw new Error("snapshot has no commit");
  return sha;
}

function toView(record: CheckpointRecord): CheckpointView {
  return {
    id: record.id,
    kind: record.kind,
    label: record.label,
    messageId: record.messageId,
    toolCallId: record.toolCallId,
    createdAt: record.createdAt,
  };
}

export async function createCheckpoint(input: {
  conversationId: string;
  workspace: string;
  kind: "turn" | "tool";
  label: string;
  messageId?: string | null;
  toolCallId?: string | null;
  messageSeq?: number | null;
}): Promise<CheckpointView | null> {
  try {
    const shadow = shadowDir(input.conversationId);
    if (!(await isDirectory(input.workspace))) return null;
    return await withConversationLock(input.conversationId, async () => {
      const commitSha = await snapshot(shadow, input.workspace, input.label);
      const record = addCheckpointRecord({
        conversationId: input.conversationId,
        kind: input.kind,
        label: input.label,
        messageId: input.messageId ?? null,
        toolCallId: input.toolCallId ?? null,
        messageSeq: input.messageSeq ?? null,
        commitSha,
      });
      return toView(record);
    });
  } catch {
    return null;
  }
}

export function checkpointViews(conversationId: string): CheckpointView[] {
  return listCheckpointRecords(conversationId).map(toView);
}

export async function restoreCheckpoint(
  conversation: ConversationRow,
  request: RestoreCheckpointRequest,
): Promise<RestoreCheckpointResult> {
  const shadow = shadowDir(conversation.id);
  return withConversationLock(conversation.id, async () => {
    const record = getCheckpointRecord(conversation.id, request.checkpointId);
    if (!record) throw new CheckpointError("This checkpoint no longer exists.", 404);
    if (request.rewindConversation && (record.kind !== "turn" || record.messageSeq === null)) {
      throw new CheckpointError(
        "Only checkpoints taken before a message can rewind the conversation. Restore the files without rewinding instead.",
        400,
      );
    }
    const workspace = conversation.workspacePath ?? defaultWorkspaceDir();
    if (!(await isDirectory(workspace))) {
      throw new CheckpointError("The task's workspace folder no longer exists, so its files cannot be restored.", 409);
    }
    const target = await shadowGit(shadow, workspace, ["cat-file", "-e", `${record.commitSha}^{commit}`]).catch(() => null);
    if (target?.code !== 0) throw new CheckpointError("The snapshot for this checkpoint is missing.", 409);

    // A restore can itself be undone: save the current files first.
    let safetySha: string;
    try {
      safetySha = await snapshot(shadow, workspace, "Before restore");
    } catch {
      throw new CheckpointError("Could not save the current files before restoring, so nothing was changed.", 409);
    }
    // The safety snapshot left the shadow index equal to the workspace, so read-tree removes files
    // created after the checkpoint and rewrites the rest. Ignored files are not in the index and stay.
    const reset = await shadowGit(shadow, workspace, ["read-tree", "-u", "--reset", record.commitSha]).catch(() => null);
    const restored = reset?.code === 0;

    let restoredPrompt: string | null = null;
    if (restored && request.rewindConversation && record.messageSeq !== null) {
      const message = listMessages(conversation.id).find((item) => item.seq === record.messageSeq);
      restoredPrompt = message?.role === "user" ? message.content : null;
      deleteMessagesFrom(conversation.id, record.messageSeq);
      deleteCheckpointsAfter(conversation.id, record);
    }
    // Recorded after any rewind cleanup, so the undo point survives it.
    addCheckpointRecord({
      conversationId: conversation.id,
      kind: "tool",
      label: "Before restore",
      messageId: null,
      toolCallId: null,
      messageSeq: null,
      commitSha: safetySha,
    });
    if (!restored) {
      throw new CheckpointError(
        'Restoring stopped partway. Restore the "Before restore" checkpoint to get back to where you were.',
        409,
      );
    }
    return {
      message: request.rewindConversation
        ? `Restored the files and rewound the conversation to "${record.label}".`
        : `Restored the files to "${record.label}".`,
      restoredPrompt,
    };
  });
}

export async function removeCheckpointStore(conversationId: string): Promise<void> {
  try {
    const shadow = shadowDir(conversationId);
    await withConversationLock(conversationId, () => fs.rm(shadow, { recursive: true, force: true, maxRetries: 3 }));
  } catch {
    // Best effort; a leftover store only uses disk space.
  }
}
