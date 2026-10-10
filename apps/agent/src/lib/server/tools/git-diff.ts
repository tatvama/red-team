import "server-only";
import path from "node:path";
import { z } from "zod";
import { workspaceDir } from "../config";
import { getConversation } from "../db";
import { GitError, workspaceDiff } from "../git";
import { truncate, type ToolDefinition, type ToolOutput } from "./types";
import { WorkspacePathError, resolveWorkspacePath } from "./workspace-path";

const schema = z
  .object({
    path: z
      .string()
      .min(1)
      .max(1000)
      .optional()
      .describe("Only show changes to this file or folder, relative to the workspace root. Omit for every change."),
  })
  .strict();

const fail = (content: string): ToolOutput => ({ status: "error", content });

export const gitDiffTool: ToolDefinition<typeof schema> = {
  name: "git_diff",
  title: "Show changes",
  description:
    "Show a unified diff of everything changed in this task so far: committed and uncommitted edits plus new " +
    "untracked files, compared with the commit the task started from (or HEAD when there is none). " +
    "Use it to review your own work before finishing, or to recall what you have already changed. Read-only.",
  schema,
  defaultPolicy: "auto",
  risk: "read",
  available: () => ({ ok: true }),
  summarize: (input) => (input.path ? `Show changes in ${input.path}` : "Show changes in the workspace"),
  async run(input, ctx) {
    const dir = workspaceDir();
    let pathspec: string | null = null;
    if (input.path) {
      try {
        const absolute = await resolveWorkspacePath(input.path);
        pathspec = path.relative(dir, absolute).split(path.sep).join("/") || ".";
      } catch (error) {
        if (error instanceof WorkspacePathError) return fail(error.message);
        throw error;
      }
    }
    try {
      const { base, againstTaskStart, text } = await workspaceDiff(getConversation(ctx.conversationId), dir, pathspec);
      const since = base
        ? `${againstTaskStart ? "the commit this task started from" : "HEAD"} (${base.slice(0, 10)})`
        : "an empty repository";
      const scope = input.path ? ` in ${input.path}` : "";
      if (!text.trim()) return { status: "ok", content: `No changes${scope} since ${since}.` };
      return { status: "ok", content: truncate(`Changes${scope} since ${since}:\n\n${text}`) };
    } catch (error) {
      if (error instanceof GitError) return fail(error.message);
      return fail(`Could not compute the diff: ${error instanceof Error ? error.message : String(error)}`);
    }
  },
};
