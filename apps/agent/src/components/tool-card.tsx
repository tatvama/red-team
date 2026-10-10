"use client";

import clsx from "clsx";
import {
  Ban,
  Brain,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  FileText,
  Globe,
  Hand,
  ListChecks,
  LoaderCircle,
  type LucideIcon,
  Pencil,
  Search,
  Terminal,
  Undo2,
} from "lucide-react";
import { memo, useId, useState } from "react";
import type { CheckpointView, SubagentView, ToolCallStatus, ToolCallView, ToolRisk } from "@/lib/contract";
import { languageFromPath } from "@/lib/client/format";
import {
  commandLine,
  diffLines,
  editPairs,
  parseToolArguments,
  prettyJson,
  stringArg,
  type ToolArguments,
} from "@/lib/client/tool-args";
import { CodeBlock, Markdown } from "./markdown";
import { SubagentGrid } from "./subagent-cards";

type IconKey = "file" | "pencil" | "terminal" | "globe" | "search" | "brain" | "plan";

const icons: Record<IconKey, LucideIcon> = {
  file: FileText,
  pencil: Pencil,
  terminal: Terminal,
  globe: Globe,
  search: Search,
  brain: Brain,
  plan: ListChecks,
};

const riskIcons: Record<ToolRisk, IconKey> = { read: "file", write: "pencil", execute: "terminal", network: "globe" };

function iconKey(name: string, risk: ToolRisk): IconKey {
  if (/plan|todo/.test(name)) return "plan";
  if (/memor|remember/.test(name)) return "brain";
  if (/search|grep|find|glob/.test(name)) return "search";
  if (/fetch|web|http|url/.test(name)) return "globe";
  if (/edit|write|patch|create|delete|move/.test(name)) return "pencil";
  if (/command|shell|exec|run/.test(name)) return "terminal";
  return riskIcons[risk];
}

export function ToolIcon({ name, risk, size = 15 }: { name: string; risk: ToolRisk; size?: number }) {
  const Icon = icons[iconKey(name, risk)];
  return <Icon size={size} aria-hidden="true" />;
}

const statusLabels: Record<ToolCallStatus, string> = {
  awaiting_approval: "Needs approval",
  running: "Running",
  ok: "Done",
  error: "Failed",
  denied: "Denied",
};

const statusIcons: Record<ToolCallStatus, LucideIcon> = {
  awaiting_approval: Hand,
  running: LoaderCircle,
  ok: CircleCheck,
  error: CircleAlert,
  denied: Ban,
};

export function StatusChip({ status }: { status: ToolCallStatus }) {
  const Icon = statusIcons[status];
  return (
    <span className={clsx("status-chip", `status-chip--${status}`)}>
      <Icon size={13} aria-hidden="true" className={status === "running" ? "spin" : undefined} />
      {statusLabels[status]}
    </span>
  );
}

function DiffView({ path, args }: { path?: string; args: ToolArguments | null }) {
  const pairs = editPairs(args);
  return (
    <div className="tool-detail">
      {path && <div className="tool-detail__path">{path}</div>}
      {pairs.map((pair, index) => (
        <pre key={index} className="diff" aria-label={`Change ${index + 1} of ${pairs.length}`}>
          {diffLines(pair.oldText, pair.newText).map((line, lineIndex) => (
            <span key={lineIndex} className={clsx("diff__line", `diff__line--${line.kind}`)}>
              <span className="diff__sign" aria-hidden="true">
                {line.kind === "del" ? "-" : "+"}
              </span>
              {line.text || " "}
            </span>
          ))}
        </pre>
      ))}
    </div>
  );
}

function OutputBlock({ output, label = "Output" }: { output?: string; label?: string }) {
  if (output === undefined || output === "") return null;
  return (
    <div className="tool-detail__section">
      <div className="tool-detail__label">{label}</div>
      <pre className="tool-scroll">{output}</pre>
    </div>
  );
}

/** Tool-specific rendering of a call's arguments and output. */
export function ToolDetails({ call }: { call: ToolCallView }) {
  const args = parseToolArguments(call.arguments);
  const path = stringArg(args, "path") ?? stringArg(args, "file_path");

  switch (call.name) {
    case "edit_file":
      return (
        <>
          <DiffView path={path} args={args} />
          <OutputBlock output={call.output} label="Result" />
        </>
      );
    case "write_file": {
      const content = stringArg(args, "content") ?? "";
      return (
        <div className="tool-detail">
          {path && <div className="tool-detail__path">{path}</div>}
          <div className="tool-scroll-frame">
            <CodeBlock code={content} language={path ? languageFromPath(path) : undefined} />
          </div>
          <OutputBlock output={call.output} label="Result" />
        </div>
      );
    }
    case "run_command": {
      const command = commandLine(args) ?? call.arguments;
      return (
        <pre className="terminal tool-scroll" aria-label="Command and output">
          <span className="terminal__prompt">
            <span aria-hidden="true">$ </span>
            {command}
          </span>
          {call.output ? `\n${call.output}` : ""}
        </pre>
      );
    }
    case "web_search":
    case "web_fetch": {
      const target = stringArg(args, "query") ?? stringArg(args, "url");
      return (
        <div className="tool-detail">
          {target && <div className="tool-detail__path">{target}</div>}
          {call.output && (
            <div className="tool-scroll tool-scroll--prose">
              <Markdown text={call.output} />
            </div>
          )}
        </div>
      );
    }
    default:
      return (
        <div className="tool-detail">
          <div className="tool-detail__section">
            <div className="tool-detail__label">Arguments</div>
            <pre className="tool-scroll">{prettyJson(call.arguments)}</pre>
          </div>
          <OutputBlock output={call.output} />
        </div>
      );
  }
}

/** The tool that starts sub-agents; its card shows their progress underneath. */
export const DELEGATE_TOOL = "delegate_tasks";

type ToolCardProps = {
  call: ToolCallView;
  /** The checkpoint taken just before this call ran, if any. */
  checkpoint?: CheckpointView;
  onRestore?: (checkpoint: CheckpointView) => void;
  restoreDisabled?: boolean;
  /** Sub-agents this call started (`delegate_tasks` only). */
  subagents?: SubagentView[];
};

export const ToolCard = memo(function ToolCard({
  call,
  checkpoint,
  onRestore,
  restoreDisabled = false,
  subagents,
}: ToolCardProps) {
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const canRestore =
    checkpoint !== undefined &&
    checkpoint.kind === "tool" &&
    onRestore !== undefined &&
    (call.risk === "write" || call.risk === "execute");
  return (
    <>
      <div className={clsx("tool-card", `tool-card--${call.status}`, expanded && "tool-card--expanded")}>
        <div className="tool-card__head">
          <button
            type="button"
            className="tool-card__row"
            aria-expanded={expanded}
            aria-controls={detailsId}
            onClick={() => setExpanded(!expanded)}
          >
            <span className="tool-card__icon">
              <ToolIcon name={call.name} risk={call.risk} />
            </span>
            <span className="tool-card__text">
              <span className="tool-card__title">{call.title || call.name}</span>
              {call.summary && <span className="tool-card__summary">{call.summary}</span>}
            </span>
            <StatusChip status={call.status} />
            <ChevronRight size={14} aria-hidden="true" className="tool-card__chevron" />
          </button>
          {canRestore && (
            <button
              type="button"
              className="icon-button tool-card__restore"
              aria-label="Restore files to before this"
              title="Restore files to before this"
              disabled={restoreDisabled}
              onClick={() => onRestore(checkpoint)}
            >
              <Undo2 size={15} aria-hidden="true" />
            </button>
          )}
        </div>
        {expanded && (
          <div id={detailsId} className="tool-card__details">
            <ToolDetails call={call} />
          </div>
        )}
      </div>
      {call.name === DELEGATE_TOOL && subagents && subagents.length > 0 && <SubagentGrid subagents={subagents} />}
    </>
  );
});
