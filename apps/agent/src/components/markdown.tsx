"use client";

import clsx from "clsx";
import { Check, Copy } from "lucide-react";
import { type ComponentProps, isValidElement, memo, type ReactNode, useEffect, useRef, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

export function CopyButton({ text, label = "Copy", ariaLabel }: { text: string; label?: string; ariaLabel?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard access can be denied (insecure origin, permissions); the text stays selectable.
    }
  }

  return (
    <button type="button" className="copy-button" onClick={copy} aria-label={copied ? "Copied" : (ariaLabel ?? `${label} code`)}>
      {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
      <span>{copied ? "Copied" : label}</span>
    </button>
  );
}

export function CodeBlock({ code, language }: { code: string; language?: string }) {
  return (
    <div className="code-block">
      <div className="code-block__header">
        <span className="code-block__lang">{language || "text"}</span>
        <CopyButton text={code} />
      </div>
      <pre className="code-block__body">
        <code>{code}</code>
      </pre>
    </div>
  );
}

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return "";
}

/** Fenced code arrives as <pre><code class="language-x">; inline code is styled by CSS. */
function Pre({ children }: ComponentProps<"pre">) {
  const child = isValidElement<{ className?: string; children?: ReactNode }>(children) ? children : null;
  const language = /language-([\w+#-]+)/.exec(child?.props.className ?? "")?.[1];
  const code = textOf(child ? child.props.children : children).replace(/\n$/, "");
  return <CodeBlock code={code} language={language} />;
}

const components: Components = {
  pre: Pre,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  ),
  // Remote images in model output could track the user or leak context, so they render as links.
  img: ({ src, alt }) =>
    typeof src === "string" && src ? (
      <a href={src} target="_blank" rel="noreferrer">
        {alt || src}
      </a>
    ) : null,
  table: ({ children }) => (
    <div className="md-table-wrap">
      <table>{children}</table>
    </div>
  ),
};

const remarkPlugins = [remarkGfm];

/** Renders untrusted markdown. Raw HTML is never interpreted (react-markdown's default). */
export const Markdown = memo(function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={clsx("markdown", className)}>
      <ReactMarkdown remarkPlugins={remarkPlugins} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
