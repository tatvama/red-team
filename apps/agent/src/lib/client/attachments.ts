import { formatBytes, languageFromPath } from "./format";

export const MAX_ATTACHMENT_BYTES = 200 * 1024;
const BINARY_SNIFF_BYTES = 8 * 1024;

export type Attachment = { id: string; name: string; size: number; text: string };

export type AttachmentResult = { ok: true; attachment: Attachment } | { ok: false; error: string };

/** Text files essentially never contain NUL bytes; binary formats almost always do early on. */
export function looksBinary(bytes: Uint8Array): boolean {
  const end = Math.min(bytes.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < end; i++) {
    if (bytes[i] === 0) return true;
  }
  return false;
}

export async function readTextAttachment(file: File, id: string): Promise<AttachmentResult> {
  if (file.size > MAX_ATTACHMENT_BYTES) {
    return { ok: false, error: `${file.name} is ${formatBytes(file.size)}. Files can be at most 200 KB.` };
  }
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (looksBinary(bytes)) return { ok: false, error: `${file.name} looks like a binary file. Attach text files only.` };
    return { ok: true, attachment: { id, name: file.name, size: file.size, text: new TextDecoder().decode(bytes) } };
  } catch {
    return { ok: false, error: `${file.name} could not be read.` };
  }
}

/** A fence longer than any backtick run inside the text, so file contents cannot close it early. */
function fenceFor(text: string): string {
  const longest = Math.max(0, ...Array.from(text.matchAll(/`+/g), (match) => match[0].length));
  return "`".repeat(Math.max(3, longest + 1));
}

/** Appends each attachment to the message as a fenced block labelled with its file name. */
export function appendAttachments(message: string, attachments: Attachment[]): string {
  const blocks = attachments.map((file) => {
    const fence = fenceFor(file.text);
    const body = file.text.endsWith("\n") ? file.text : `${file.text}\n`;
    return `File: ${file.name}\n${fence}${languageFromPath(file.name)}\n${body}${fence}`;
  });
  return [message.trim(), ...blocks].filter(Boolean).join("\n\n");
}
