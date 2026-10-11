export type ToolArguments = Record<string, unknown>;

/** Parses model-produced arguments. Returns null for anything that is not a JSON object. */
export function parseToolArguments(raw: string): ToolArguments | null {
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as ToolArguments) : null;
  } catch {
    return null;
  }
}

export function stringArg(args: ToolArguments | null, key: string): string | undefined {
  const value = args?.[key];
  return typeof value === "string" ? value : undefined;
}

export function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

export type DiffLine = { kind: "del" | "add"; text: string };

/** Old text as removed lines followed by new text as added lines. */
export function diffLines(oldText: string, newText: string): DiffLine[] {
  const split = (text: string) => (text === "" ? [] : text.replace(/\r\n/g, "\n").split("\n"));
  return [
    ...split(oldText).map((text): DiffLine => ({ kind: "del", text })),
    ...split(newText).map((text): DiffLine => ({ kind: "add", text })),
  ];
}

export type EditPair = { oldText: string; newText: string };

/** Edits from `old_string`/`new_string`, or from an `edits` array of such pairs. */
export function editPairs(args: ToolArguments | null): EditPair[] {
  const single = { oldText: stringArg(args, "old_string"), newText: stringArg(args, "new_string") };
  if (single.oldText !== undefined || single.newText !== undefined) {
    return [{ oldText: single.oldText ?? "", newText: single.newText ?? "" }];
  }
  const edits = args?.edits;
  if (!Array.isArray(edits)) return [];
  return edits.flatMap((edit: unknown) => {
    if (typeof edit !== "object" || edit === null) return [];
    const record = edit as ToolArguments;
    const oldText = stringArg(record, "old_string") ?? "";
    const newText = stringArg(record, "new_string") ?? "";
    return oldText || newText ? [{ oldText, newText }] : [];
  });
}

/** The shell command line from `command` plus an optional `args` array. */
export function commandLine(args: ToolArguments | null): string | undefined {
  const command = stringArg(args, "command");
  if (command === undefined) return undefined;
  const extra = Array.isArray(args?.args)
    ? args.args.filter((part): part is string => typeof part === "string").map(quoteArg)
    : [];
  return [command, ...extra].join(" ");
}

function quoteArg(part: string): string {
  return /^[\w@%+=:,./-]+$/.test(part) ? part : `"${part.replace(/(["\\$`])/g, "\\$1")}"`;
}
