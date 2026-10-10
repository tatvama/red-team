import fs from "node:fs/promises";
import path from "node:path";
import { workspaceDir } from "../config";

/** Directories skipped when walking the workspace: dependencies, build output and VCS metadata. */
export const IGNORED_DIRS: ReadonlySet<string> = new Set([
  ".git",
  "node_modules",
  ".next",
  "dist",
  "build",
  ".venv",
  "__pycache__",
  ".turbo",
  "coverage",
]);

/** Thrown for any path the model is not allowed to touch. The message is safe to show the model. */
export class WorkspacePathError extends Error {
  override name = "WorkspacePathError";
}

const isWindows = process.platform === "win32";

// Windows maps these names to devices in every directory (`NUL`, `COM1.txt`, ...). Opening one can
// hang or write to a device instead of a file, so they are refused on Windows.
const WINDOWS_DEVICE_NAME = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

/** Creates the workspace directory if needed and returns its absolute path. */
export async function ensureWorkspace(): Promise<string> {
  const root = workspaceDir();
  await fs.mkdir(root, { recursive: true });
  return root;
}

function comparable(p: string): string {
  return isWindows ? p.toLowerCase() : p;
}

/** True when `candidate` is `root` or lies beneath it. Both must be absolute and normalized. */
export function isInside(root: string, candidate: string): boolean {
  const r = comparable(root);
  const c = comparable(candidate);
  const prefix = r.endsWith(path.sep) ? r : r + path.sep;
  return c === r || c.startsWith(prefix);
}

function rejectSyntax(relative: string): void {
  if (relative.trim() === "") throw new WorkspacePathError("Path is empty");
  if (relative.includes("\0")) throw new WorkspacePathError("Path contains a NUL byte");
  // Check both flavours regardless of host OS: `/etc/passwd`, `C:\x`, `C:x`, `\\server\share`, `\\?\C:\`.
  if (path.posix.isAbsolute(relative) || path.win32.isAbsolute(relative) || /^[a-zA-Z]:/.test(relative)) {
    throw new WorkspacePathError(`Path must be relative to the workspace: ${relative}`);
  }
  if (isWindows) {
    // A colon after the drive check can only be an NTFS alternate data stream (`file.txt:hidden`).
    if (relative.includes(":")) throw new WorkspacePathError(`Path may not contain ':': ${relative}`);
    if (relative.split(/[\\/]/).some((segment) => WINDOWS_DEVICE_NAME.test(segment))) {
      throw new WorkspacePathError(`Path uses a reserved Windows device name: ${relative}`);
    }
  }
}

/**
 * Resolves a model-supplied path against the workspace and proves it stays inside, including
 * through symlinks and junctions. Returns the absolute (lexical) path.
 *
 * The lexical check alone is not enough: `link/secret` can look contained while `link` points
 * elsewhere. So the deepest entry that exists (found with lstat, so a dangling symlink counts as
 * existing) is realpath'd and must land inside the realpath'd workspace. A dangling symlink fails
 * realpath and is refused, because writing through it would create its target wherever it points.
 */
export async function resolveWorkspacePath(relative: string): Promise<string> {
  rejectSyntax(relative);
  const root = await ensureWorkspace();
  const absolute = path.resolve(root, relative);
  if (!isInside(root, absolute)) {
    throw new WorkspacePathError(`Path escapes the workspace: ${relative}`);
  }

  const realRoot = await fs.realpath(root);
  const realExisting = await realDeepestExisting(absolute, relative);
  if (!isInside(realRoot, realExisting)) {
    throw new WorkspacePathError(`Path escapes the workspace through a link: ${relative}`);
  }
  return absolute;
}

/** Realpath of the deepest part of `absolute` that exists (lstat, so a dangling link counts). */
async function realDeepestExisting(absolute: string, relative: string): Promise<string> {
  let existing = absolute;
  for (;;) {
    try {
      await fs.lstat(existing);
      break;
    } catch {
      // Not there yet (for example a file about to be written); check its parent instead.
      existing = path.dirname(existing);
    }
  }
  try {
    return await fs.realpath(existing);
  } catch {
    throw new WorkspacePathError(`Path goes through a broken link: ${relative}`);
  }
}

/**
 * True when any segment is `.git`, in any letter case. Windows also opens `.git` for `.git.`,
 * `.git ` and the short name `git~1`, so those count too.
 */
export function hasGitSegment(relative: string): boolean {
  return relative.split(/[\\/]+/).some((segment) => {
    const name = segment.toLowerCase();
    return name.replace(/[. ]+$/, "") === ".git" || /^git~\d+$/.test(name);
  });
}

/**
 * resolveWorkspacePath for writes: also refuses git metadata (`.git/config`, `sub/.GIT/x`), including
 * through a link inside the workspace that points into a `.git` folder. Editing git metadata could
 * make git run commands, so tools may read it but never change it.
 */
export async function resolveWritablePath(relative: string): Promise<string> {
  const absolute = await resolveWorkspacePath(relative);
  const refuse = () => new WorkspacePathError(`Git metadata cannot be edited: ${relative}`);
  if (hasGitSegment(relative) || hasGitSegment(path.relative(workspaceDir(), absolute))) throw refuse();
  const realRoot = await fs.realpath(workspaceDir());
  const realExisting = await realDeepestExisting(absolute, relative);
  if (hasGitSegment(path.relative(realRoot, realExisting))) throw refuse();
  return absolute;
}

/** Forward-slash path relative to the workspace for display, `.` for the root itself. */
export function toWorkspaceRelative(absolute: string): string {
  const relative = path.relative(workspaceDir(), absolute);
  return relative === "" ? "." : relative.split(path.sep).join("/");
}

export type WalkEntry = { path: string; isDirectory: boolean };

/**
 * Depth-first walk in name order, skipping IGNORED_DIRS. Symlinks and junctions are not followed
 * or yielded: following one could leave the workspace without passing resolveWorkspacePath.
 */
export async function* walkWorkspace(dir: string, signal?: AbortSignal): AsyncGenerator<WalkEntry> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return; // Unreadable directories are skipped rather than failing the whole walk.
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    if (signal?.aborted) return;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      yield { path: full, isDirectory: true };
      yield* walkWorkspace(full, signal);
    } else if (entry.isFile()) {
      yield { path: full, isDirectory: false };
    }
  }
}

/**
 * Small glob matcher for model-supplied patterns: `**` (any depth), `*`, `?` and `{a,b}`.
 * Patterns are matched against forward-slash relative paths. A pattern without `/` matches the
 * file name at any depth, so `*.ts` behaves like `**\/*.ts`.
 */
export function globToRegExp(pattern: string): RegExp {
  let source = pattern.trim().replace(/\\/g, "/").replace(/^(\.\/)+/, "");
  if (!source.includes("/")) source = `**/${source}`;
  return new RegExp(`^${translateGlob(source)}$`);
}

function translateGlob(glob: string): string {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        const atSegmentStart = i === 0 || glob[i - 1] === "/";
        if (atSegmentStart && glob[i + 2] === "/") {
          out += "(?:.*/)?"; // `**/` matches zero or more directories.
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else if (ch === "{") {
      const close = findBraceEnd(glob, i);
      if (close === -1) {
        out += "\\{";
      } else {
        const alternatives = splitTopLevel(glob.slice(i + 1, close));
        out += `(?:${alternatives.map(translateGlob).join("|")})`;
        i = close;
      }
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return out;
}

function findBraceEnd(glob: string, open: number): number {
  let depth = 0;
  for (let i = open; i < glob.length; i++) {
    if (glob[i] === "{") depth++;
    else if (glob[i] === "}" && --depth === 0) return i;
  }
  return -1;
}

function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "{") depth++;
    else if (body[i] === "}") depth--;
    else if (body[i] === "," && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));
  return parts;
}
