import type { ConversationSummary } from "@/lib/contract";

export type ConversationGroup = { label: string; conversations: ConversationSummary[] };

const DAY_MS = 24 * 60 * 60 * 1000;

/** Groups conversations (already newest first) into Today, Previous 7 days and Older. */
export function groupConversations(conversations: ConversationSummary[], now: Date): ConversationGroup[] {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const weekAgo = startOfToday - 7 * DAY_MS;
  const groups: ConversationGroup[] = [
    { label: "Today", conversations: [] },
    { label: "Previous 7 days", conversations: [] },
    { label: "Older", conversations: [] },
  ];
  for (const conversation of conversations) {
    const time = Date.parse(conversation.updatedAt);
    const index = Number.isNaN(time) ? 2 : time >= startOfToday ? 0 : time >= weekAgo ? 1 : 2;
    groups[index].conversations.push(conversation);
  }
  return groups.filter((group) => group.conversations.length > 0);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const languageByExtension: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  md: "markdown",
  py: "python",
  rs: "rust",
  go: "go",
  java: "java",
  rb: "ruby",
  php: "php",
  cs: "csharp",
  c: "c",
  h: "c",
  cpp: "cpp",
  css: "css",
  scss: "scss",
  html: "html",
  sql: "sql",
  sh: "bash",
  ps1: "powershell",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  xml: "xml",
  txt: "text",
};

/** A code-fence language for a file name, or an empty string when unknown. */
export function languageFromPath(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "";
  return languageByExtension[name.slice(dot + 1).toLowerCase()] ?? "";
}

/** Time of day for today's timestamps, date and time for older ones. Empty for an invalid timestamp. */
export function formatTimestamp(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const sameDay =
    date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (sameDay) return time;
  const day = date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: date.getFullYear() === now.getFullYear() ? undefined : "numeric",
  });
  return `${day}, ${time}`;
}

/** Only http(s) links from server responses become clickable. */
export function isHttpUrl(value: string | null | undefined): value is string {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}
