// Dependency-free HTML to readable text for web_fetch. It is not a full HTML parser: it aims for
// compact, markdown-ish text that keeps headings, lists, links and code blocks recognisable.

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  copy: "©",
  reg: "®",
  trade: "™",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  laquo: "«",
  raquo: "»",
  bull: "•",
  middot: "·",
  times: "×",
  divide: "÷",
  deg: "°",
  plusmn: "±",
  euro: "€",
  pound: "£",
  yen: "¥",
  cent: "¢",
  sect: "§",
  para: "¶",
  rarr: "→",
  larr: "←",
  zwj: "‍",
  zwnj: "‌",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]*);/gi, (match, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      const valid = code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff);
      return valid ? String.fromCodePoint(code) : "�";
    }
    return Object.hasOwn(NAMED_ENTITIES, body.toLowerCase()) ? NAMED_ENTITIES[body.toLowerCase()] : match;
  });
}

/** Removes anything that looks like a tag. Bare `<` in text (as in `a < b`) is left alone. */
export function stripTags(html: string): string {
  return html.replace(/<\/?[a-z!][^>]*>/gi, "");
}

const DROPPED_ELEMENTS = /<(script|style|noscript|svg|head|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const BLOCK_TAGS =
  /<\/?(?:div|section|article|header|footer|nav|aside|main|ul|ol|dl|dt|dd|table|thead|tbody|tfoot|tr|blockquote|figure|figcaption|form|fieldset|details|summary|address|hr|center)\b[^>]*>/gi;
// Private-use characters mark where preformatted blocks go back in after whitespace collapsing.
const PRE_MARK = /(\d+)/g;

export function htmlToText(html: string): { title: string; text: string } {
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html);
  const title = titleMatch ? decodeEntities(stripTags(titleMatch[1])).replace(/\s+/g, " ").trim() : "";

  let body = html.replace(/<!--[\s\S]*?-->/g, "").replace(DROPPED_ELEMENTS, "");

  // Code samples are the most useful part of many docs pages, so <pre> keeps its line breaks.
  const preBlocks: string[] = [];
  body = body.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre\s*>/gi, (_match, inner: string) => {
    preBlocks.push(decodeEntities(stripTags(inner.replace(/<br\s*\/?>/gi, "\n"))).replace(/\s+$/, ""));
    return `\n${preBlocks.length - 1}\n`;
  });

  // Source line breaks are just spaces in HTML; structure comes from the tags below.
  body = body.replace(/\s+/g, " ");

  body = body.replace(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi, (_match, attributes: string, inner: string) => {
    // Entities stay encoded here; the whole text is decoded once at the end.
    const label = stripTags(inner).trim();
    const hrefMatch = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attributes);
    const href = (hrefMatch?.[1] ?? hrefMatch?.[2] ?? hrefMatch?.[3] ?? "").trim();
    if (!/^https?:\/\//i.test(decodeEntities(href))) return label;
    if (!label) return href;
    return label === href ? label : `${label} (${href})`;
  });
  body = body.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi, (_match, level: string, inner: string) => {
    return `\n\n${"#".repeat(Number(level))} ${stripTags(inner).trim()}\n\n`;
  });
  body = body
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/li\s*>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?p\b[^>]*>/gi, "\n\n")
    .replace(BLOCK_TAGS, "\n")
    .replace(/<\/?t[dh]\b[^>]*>/gi, " ");

  const text = decodeEntities(stripTags(body))
    .replace(/[^\S\n]+/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .replace(PRE_MARK, (_match, index: string) => `\`\`\`\n${preBlocks[Number(index)]}\n\`\`\``);

  return { title, text };
}
