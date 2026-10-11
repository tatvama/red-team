import "server-only";
import { isIPv6 } from "node:net";
import { dataDir, defaultWorkspaceDir } from "../config";

// Masks secrets (always) and personal data (optionally) in text that leaves the machine as a
// training dataset. Deterministic and side-effect free: the same input always gives the same output,
// and running it again on its own output changes nothing.

export type RedactionCounts = Record<string, number>;
export type RedactOptions = {
  /** Also mask emails, phone numbers and IP addresses. Secrets are always masked. */
  pii: boolean;
  /** Absolute folders whose paths become `/workspace`. Defaults to the workspace and data folders. */
  roots?: readonly string[];
};
export type RedactResult = { text: string; counts: RedactionCounts };

/** The placeholder written for each kind of masked value. Paths are rewritten to `/workspace` instead. */
export const REDACTION_PLACEHOLDERS = {
  private_key: "[REDACTED_PRIVATE_KEY]",
  url_credentials: "[REDACTED_CREDENTIALS]",
  jwt: "[REDACTED_JWT]",
  api_key: "[REDACTED_API_KEY]",
  github_token: "[REDACTED_GITHUB_TOKEN]",
  aws_key: "[REDACTED_AWS_KEY]",
  slack_token: "[REDACTED_SLACK_TOKEN]",
  hf_token: "[REDACTED_HF_TOKEN]",
  google_api_key: "[REDACTED_GOOGLE_KEY]",
  bearer_token: "[REDACTED_TOKEN]",
  secret: "[REDACTED_SECRET]",
  email: "[REDACTED_EMAIL]",
  phone: "[REDACTED_PHONE]",
  ip_address: "[REDACTED_IP]",
} as const;
type Kind = keyof typeof REDACTION_PLACEHOLDERS | "path";
const P = REDACTION_PLACEHOLDERS;

/** Returns the replacement, or null to keep the match as it is. */
type Replacer = (match: string, groups: (string | undefined)[], offset: number, input: string) => string | null;
type Rule = { kind: Kind; pattern: RegExp; replace: Replacer };

const fixed =
  (kind: keyof typeof REDACTION_PLACEHOLDERS): Replacer =>
  () =>
    P[kind];

// ── Secrets ──────────────────────────────────────────────────────────────────

const SECRET_WORDS = String.raw`(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|secret[_-]?key|private[_-]?key)`;
/** A JSON key or variable name that holds a secret, for example `DB_PASSWORD`, `apiKey` or `x-api-key`. */
const SECRET_KEY_NAME = new RegExp(`${SECRET_WORDS}$`, "i");

/** Values that are clearly not a secret: types, keywords and empty markers. */
const CODE_WORDS = new Set([
  "any", "array", "bool", "boolean", "bytes", "char", "default", "dict", "empty", "env", "false", "float", "hidden",
  "int", "integer", "list", "map", "masked", "never", "nil", "none", "null", "number", "object", "optional",
  "redacted", "required", "secretstr", "set", "str", "string", "text", "true", "undefined", "unknown", "value",
  "varchar", "void",
]);

/** Templates and placeholders such as `${TOKEN}`, `%TOKEN%`, `<your key>`, `{{ secrets.X }}` or `****`. */
function isPlaceholderValue(value: string): boolean {
  const trimmed = value.trim();
  return !trimmed || /^(?:\$|%|<|\{\{|\[REDACTED_)/.test(trimmed) || /^\*+$/.test(trimmed);
}

function looksLikeSecret(value: string, key: string, tight: boolean): boolean {
  if (value.length < 3 || isPlaceholderValue(value) || /^[{[(]/.test(value)) return false;
  if (CODE_WORDS.has(value.toLowerCase())) return false;
  // Ordinary numbers and versions (`max_token=1024`, `token: 1.2.3`).
  if (/^\d{1,5}$/.test(value) || /^\d+(?:\.\d+)+$/.test(value)) return false;
  // Member access in code: `process.env.TOKEN`, `config.apiKey`, `self.token`.
  if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(value)) return false;
  // A variable holding the secret, not the secret itself: `token=token`, `password: userPassword`.
  if (/^[A-Za-z_$][\w$]*$/.test(value) && (/pass|pwd|secret|token|key|cred|auth/i.test(value) || value === key)) return false;
  if (tight) return true;
  // `key: value` and `key = value` also appear in prose and code, so the value must not be a plain word.
  return /[^A-Za-z]/.test(value);
}

const ASSIGNMENT = new RegExp(
  String.raw`(?<![\w.-])([\w.-]*?${SECRET_WORDS})(?![\w-])(["']?[ \t]*(?::=|=(?![=>~])|:(?![:/]))[ \t]*)` +
    String.raw`(?:(["'\x60])((?:(?!\3)[^\\\r\n]|\\.){0,2000})\3|([^\s"'\x60,;(){}\[\]<>&|\\]+))`,
  "gi",
);

const assignment: Replacer = (match, [key = "", separator = "", quote, quoted, bare], offset, input) => {
  if (quote !== undefined) {
    if (quoted === undefined || isPlaceholderValue(quoted)) return null;
    return `${key}${separator}${quote}${P.secret}${quote}`;
  }
  if (bare === undefined) return null;
  // A call such as `token = getToken()` is code.
  if (input[offset + match.length] === "(") return null;
  const trailing = /[.!?:]+$/.exec(bare)?.[0] ?? "";
  const value = bare.slice(0, bare.length - trailing.length);
  const name = key.replace(/^.*[.-]/, "");
  // `KEY=value` (env files, query strings, flags) and UPPER_CASE keys are config, not prose.
  const tight = (!/[ \t]/.test(separator) && separator.includes("=")) || /^[A-Z][A-Z0-9_]*$/.test(name);
  if (!looksLikeSecret(value, name, tight)) return null;
  return `${key}${separator}${P.secret}${trailing}`;
};

const AUTH_SCHEMES = "(?:Bearer|Basic|Token|Digest|ApiKey)";

const SECRET_RULES: Rule[] = [
  {
    kind: "private_key",
    // A whole PEM block, or a truncated one (BEGIN line and the base64 that follows).
    pattern:
      /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----(?:[\s\S]*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----|[A-Za-z0-9+/=\s\\]*)/g,
    replace: fixed("private_key"),
  },
  {
    kind: "url_credentials",
    // https://user:pass@host keeps the scheme and host, masks both user and password.
    pattern: /\b([a-z][a-z0-9+.-]{1,30}:\/\/)([^\s:/?#@"'<>\x60]+):([^\s/?#@"'<>\x60]+)@/gi,
    replace: (_match, [scheme]) => `${scheme}${P.url_credentials}@`,
  },
  {
    kind: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
    replace: fixed("jwt"),
  },
  {
    kind: "api_key",
    // OpenAI-style keys (sk-..., sk-proj-...). Real keys mix letters and digits; CSS-like names do not.
    pattern: /(?<![\w-])sk-[A-Za-z0-9][A-Za-z0-9_-]{18,}/g,
    replace: (match) => (/\d/.test(match) && /[A-Za-z]/.test(match.slice(3)) && !match.includes("--") ? P.api_key : null),
  },
  {
    kind: "github_token",
    pattern: /(?<![\w])(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/g,
    replace: fixed("github_token"),
  },
  { kind: "aws_key", pattern: /(?<![A-Za-z0-9])(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}(?![A-Za-z0-9])/g, replace: fixed("aws_key") },
  { kind: "slack_token", pattern: /(?<![\w-])xox[abposr]-[A-Za-z0-9-]{10,}/g, replace: fixed("slack_token") },
  { kind: "hf_token", pattern: /(?<![\w])hf_[A-Za-z0-9]{30,}/g, replace: fixed("hf_token") },
  { kind: "google_api_key", pattern: /(?<![\w-])AIza[0-9A-Za-z_-]{35}(?![\w-])/g, replace: fixed("google_api_key") },
  {
    kind: "bearer_token",
    // Authorization headers keep the header name and scheme. Without a scheme the value must look random.
    pattern: new RegExp(String.raw`(\bAuthorization["']?[ \t]*[:=][ \t]*["']?)(${AUTH_SCHEMES}[ \t]+)?([\w.~+/-]{8,}=*)`, "gi"),
    replace: (_match, [prefix, scheme, value = ""]) => {
      if (!scheme && !(value.length >= 16 && /\d/.test(value) && /[A-Za-z]/.test(value))) return null;
      return `${prefix}${scheme ?? ""}${P.bearer_token}`;
    },
  },
  {
    kind: "bearer_token",
    pattern: /(\bBearer[ \t]+)([\w.~+/-]{20,}=*)/gi,
    replace: (_match, [prefix]) => `${prefix}${P.bearer_token}`,
  },
  { kind: "secret", pattern: ASSIGNMENT, replace: assignment },
];

// ── Personal data ────────────────────────────────────────────────────────────

/** `logo@2x.png` and `name@file.ts` look like emails but end in a file extension. */
const FILE_EXTENSIONS = new Set(
  "png jpg jpeg gif svg webp ico bmp js mjs cjs ts tsx jsx css scss sass less json lock yml yaml toml py rb go rs java kt swift txt html htm xml map vue".split(
    " ",
  ),
);

function digitCount(value: string): number {
  return value.replace(/\D/g, "").length;
}

function isPublicIPv4(value: string): boolean {
  // Loopback, "any" and netmasks identify no one.
  return !value.startsWith("127.") && value !== "0.0.0.0" && !value.startsWith("255.");
}

const OCTET = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";

const PII_RULES: Rule[] = [
  {
    kind: "email",
    pattern:
      /(?<![\w.%+-])([\w.%+-]+)@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.([A-Za-z]{2,24})(?![\w-])/g,
    replace: (_match, [local = "", tld = ""]) =>
      local.toLowerCase() === "git" || FILE_EXTENSIONS.has(tld.toLowerCase()) ? null : P.email,
  },
  {
    kind: "ip_address",
    // Candidates are checked with node:net. Python slices (`1::2`), times and MAC addresses fail the check.
    pattern: /(?<![\w:.])(?:[0-9A-Fa-f]{0,4}:){2,7}(?:[0-9A-Fa-f]{1,4}|(?:\d{1,3}\.){3}\d{1,3})?(?![\w:])/g,
    replace: (match) => {
      if (!isIPv6(match)) return null;
      const groups = match.split(":").filter(Boolean);
      return groups.length >= 3 ? P.ip_address : null;
    },
  },
  {
    kind: "ip_address",
    pattern: new RegExp(String.raw`(?<![\w.])(?:${OCTET}\.){3}${OCTET}(?![\w-]|\.\d)`, "g"),
    replace: (match) => (isPublicIPv4(match) ? P.ip_address : null),
  },
  {
    kind: "phone",
    // International numbers need a leading + and 10 to 15 digits.
    pattern: /(?<![\w+])\+\d{1,3}(?:[ .-]?\(\d{1,4}\)|[ .-]?\d{1,4})(?:[ .-]?\d{2,5}){1,4}(?![\w-]|\.\d)/g,
    replace: (match) => {
      const digits = digitCount(match);
      return digits >= 10 && digits <= 15 ? P.phone : null;
    },
  },
  {
    kind: "phone",
    // North American formats: (555) 123-4567, 555-123-4567, 555.123.4567 (same separator twice).
    pattern: /(?<![\w(.+-])(?:\(\d{3}\)[ ]?\d{3}[-. ]\d{4}|\d{3}([-.])\d{3}\1\d{4})(?![\w-]|\.\d)/g,
    replace: fixed("phone"),
  },
];

// ── Paths ────────────────────────────────────────────────────────────────────

const SEP = String.raw`(?:\\{1,2}|/)`;
const NAME = String.raw`[^\s"'\x60<>|*?\\/:,;()\[\]{}]`;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Matches a root in its Windows (`D:\a`, `D:/a`, `D:\\a`), MSYS (`/d/a`) or POSIX (`/a/b`) form. */
function rootPattern(root: string): string | null {
  const parts = root.split(/[\\/]+/).filter(Boolean);
  const drive = /^[A-Za-z]:$/.test(parts[0] ?? "") ? parts.shift()![0] : null;
  // Never rewrite a whole drive or the filesystem root.
  if (!parts.length) return null;
  const body = parts.map(escapeRegExp).join(SEP);
  if (drive) return String.raw`(?:(?<![\w])${drive}:${SEP}|(?<![\w/.~-])/${drive}/)${body}`;
  if (body.toLowerCase() === "workspace") return null;
  return String.raw`(?<![\w/.~-])/${body}`;
}

const pathRules = new Map<string, Rule | null>();

function pathRule(roots: readonly string[]): Rule | null {
  const key = roots.join("\0");
  if (pathRules.has(key)) return pathRules.get(key)!;
  // Longest first, so a worktree inside DATA_DIR wins over DATA_DIR itself.
  const patterns = [...new Set(roots)]
    .sort((a, b) => b.length - a.length)
    .map(rootPattern)
    .filter((pattern): pattern is string => pattern !== null);
  const rule: Rule | null = patterns.length
    ? {
        kind: "path",
        pattern: new RegExp(`(?:${patterns.join("|")})(?!${NAME})((?:${SEP}${NAME}+)*)(${SEP})?`, "gi"),
        replace: (_match, [rest = "", trailing]) => `/workspace${rest.replace(/\\{1,2}/g, "/")}${trailing ? "/" : ""}`,
      }
    : null;
  if (pathRules.size > 200) pathRules.clear();
  pathRules.set(key, rule);
  return rule;
}

/** The folders Tatvam works in: the default workspace and DATA_DIR (which holds task worktrees). */
export function defaultRedactionRoots(): string[] {
  return [defaultWorkspaceDir(), dataDir()];
}

// ── Public API ───────────────────────────────────────────────────────────────

function apply(text: string, rule: Rule, counts: RedactionCounts): string {
  return text.replace(rule.pattern, (...args: unknown[]) => {
    const match = args[0] as string;
    const input = args[args.length - 1] as string;
    const offset = args[args.length - 2] as number;
    const groups = args.slice(1, -2) as (string | undefined)[];
    const replacement = rule.replace(match, groups, offset, input);
    if (replacement === null || replacement === match) return match;
    counts[rule.kind] = (counts[rule.kind] ?? 0) + 1;
    return replacement;
  });
}

export function addCounts(target: RedactionCounts, source: RedactionCounts): RedactionCounts {
  for (const [kind, count] of Object.entries(source)) target[kind] = (target[kind] ?? 0) + count;
  return target;
}

/** Masks secrets, rewrites workspace paths and, with `pii`, masks emails, phone numbers and IP addresses. */
export function redact(text: string, options: RedactOptions): RedactResult {
  const counts: RedactionCounts = {};
  if (!text) return { text, counts };
  let output = text;
  for (const rule of SECRET_RULES) output = apply(output, rule, counts);
  const paths = pathRule(options.roots ?? defaultRedactionRoots());
  if (paths) output = apply(output, paths, counts);
  if (options.pii) for (const rule of PII_RULES) output = apply(output, rule, counts);
  return { text: output, counts };
}

/**
 * Redacts a tool call's JSON arguments value by value, so escapes stay valid and a secret under a
 * key such as `"password"` is masked even though the value alone looks ordinary. Arguments that are
 * not JSON are redacted as text. Unchanged arguments are returned exactly as they were.
 */
export function redactArguments(raw: string, options: RedactOptions): RedactResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return redact(raw, options);
  }
  if (parsed === null || typeof parsed !== "object") return redact(raw, options);
  const counts: RedactionCounts = {};
  const walk = (value: unknown, key?: string): unknown => {
    if (typeof value === "string") {
      if (key !== undefined && SECRET_KEY_NAME.test(key) && !isPlaceholderValue(value)) {
        counts.secret = (counts.secret ?? 0) + 1;
        return P.secret;
      }
      const result = redact(value, options);
      addCounts(counts, result.counts);
      return result.text;
    }
    if (Array.isArray(value)) return value.map((item) => walk(item));
    if (value && typeof value === "object")
      return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, walk(item, name)]));
    return value;
  };
  const result = walk(parsed);
  return Object.keys(counts).length ? { text: JSON.stringify(result), counts } : { text: raw, counts };
}
