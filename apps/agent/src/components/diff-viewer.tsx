"use client";

import clsx from "clsx";
import { ChevronRight, FileMinus, FilePen, FilePlus, FileSymlink, type LucideIcon } from "lucide-react";
import { memo, useId, useState } from "react";
import type { DiffFile, DiffHunk, DiffLine } from "@/lib/contract";

export type DiffViewMode = "unified" | "split";

const statusIcons: Record<DiffFile["status"], LucideIcon> = {
  added: FilePlus,
  modified: FilePen,
  deleted: FileMinus,
  renamed: FileSymlink,
};

const statusLabels: Record<DiffFile["status"], string> = {
  added: "Added",
  modified: "Modified",
  deleted: "Deleted",
  renamed: "Renamed",
};

const signs: Record<DiffLine["type"], string> = { add: "+", del: "-", context: " " };

export function DiffStat({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="diff-stat">
      <span className="diff-stat__add">
        +{additions}
        <span className="sr-only"> added</span>
      </span>
      <span className="diff-stat__del">
        −{deletions}
        <span className="sr-only"> removed</span>
      </span>
    </span>
  );
}

function UnifiedHunks({ path, hunks }: { path: string; hunks: DiffHunk[] }) {
  return (
    <div className="diff-scroll">
      <table className="diff-table diff-table--unified">
        <caption className="sr-only">Changes in {path}, unified view</caption>
        {hunks.map((hunk, hunkIndex) => (
          <tbody key={hunkIndex}>
            <tr className="diff-hunk">
              <td colSpan={4}>{hunk.header}</td>
            </tr>
            {hunk.lines.map((line, lineIndex) => (
              <tr key={lineIndex} className={clsx("diff-row", `diff-row--${line.type}`)} data-type={line.type}>
                <td className="diff-num" data-side="old">
                  {line.oldLine ?? ""}
                </td>
                <td className="diff-num" data-side="new">
                  {line.newLine ?? ""}
                </td>
                <td className="diff-sign">{signs[line.type]}</td>
                <td className="diff-code">{line.text || " "}</td>
              </tr>
            ))}
          </tbody>
        ))}
      </table>
    </div>
  );
}

type SplitCell = { number: number | null; text: string; type: DiffLine["type"] } | null;
export type SplitRow = { left: SplitCell; right: SplitCell };

/** Pairs a hunk's lines side by side: context on both sides, each run of deletions next to the additions after it. */
export function splitRows(lines: DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let deleted: DiffLine[] = [];
  let added: DiffLine[] = [];
  const flush = () => {
    const count = Math.max(deleted.length, added.length);
    for (let index = 0; index < count; index++) {
      const del = deleted[index];
      const add = added[index];
      rows.push({
        left: del ? { number: del.oldLine, text: del.text, type: "del" } : null,
        right: add ? { number: add.newLine, text: add.text, type: "add" } : null,
      });
    }
    deleted = [];
    added = [];
  };
  for (const line of lines) {
    if (line.type === "context") {
      flush();
      rows.push({
        left: { number: line.oldLine, text: line.text, type: "context" },
        right: { number: line.newLine, text: line.text, type: "context" },
      });
    } else if (line.type === "del") {
      if (added.length > 0) flush();
      deleted.push(line);
    } else {
      added.push(line);
    }
  }
  flush();
  return rows;
}

function SplitCells({ cell, side }: { cell: SplitCell; side: "old" | "new" }) {
  if (!cell) {
    return (
      <>
        <td className="diff-num diff-cell--empty" data-side={side} />
        <td className="diff-code diff-cell--empty" />
      </>
    );
  }
  return (
    <>
      <td className={clsx("diff-num", `diff-cell--${cell.type}`)} data-side={side}>
        {cell.number ?? ""}
      </td>
      <td className={clsx("diff-code", `diff-cell--${cell.type}`)}>
        <span className="diff-code__sign" aria-hidden={cell.type === "context" ? true : undefined}>
          {signs[cell.type]}
        </span>
        {cell.text || " "}
      </td>
    </>
  );
}

function SplitHunks({ path, hunks }: { path: string; hunks: DiffHunk[] }) {
  return (
    <div className="diff-scroll">
      <table className="diff-table diff-table--split">
        <caption className="sr-only">Changes in {path}, side by side: before on the left, after on the right</caption>
        <colgroup>
          <col className="diff-col-num" />
          <col />
          <col className="diff-col-num" />
          <col />
        </colgroup>
        {hunks.map((hunk, hunkIndex) => (
          <tbody key={hunkIndex}>
            <tr className="diff-hunk">
              <td colSpan={4}>{hunk.header}</td>
            </tr>
            {splitRows(hunk.lines).map((row, rowIndex) => (
              <tr key={rowIndex} className="diff-row">
                <SplitCells cell={row.left} side="old" />
                <SplitCells cell={row.right} side="new" />
              </tr>
            ))}
          </tbody>
        ))}
      </table>
    </div>
  );
}

type DiffFileViewProps = {
  file: DiffFile;
  view: DiffViewMode;
  defaultOpen?: boolean;
};

/** One changed file: a collapsible header with status and counts, then its hunks. */
export const DiffFileView = memo(function DiffFileView({ file, view, defaultOpen = true }: DiffFileViewProps) {
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = useId();
  const StatusIcon = statusIcons[file.status];
  const renamedFrom = file.status === "renamed" && file.oldPath ? file.oldPath : null;
  const hasHunks = file.hunks.some((hunk) => hunk.lines.length > 0);
  const label = [
    `${statusLabels[file.status]}: ${renamedFrom ? `${renamedFrom} renamed to ` : ""}${file.path}`,
    `${file.additions} added, ${file.deletions} removed`,
    file.binary ? "binary" : null,
    file.truncated ? "truncated" : null,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <section className={clsx("diff-file", open && "diff-file--open")}>
      <h3 className="diff-file__heading">
        <button
          type="button"
          className="diff-file__toggle"
          aria-expanded={open}
          aria-controls={bodyId}
          aria-label={label}
          onClick={() => setOpen(!open)}
        >
          <ChevronRight size={14} aria-hidden="true" className="diff-file__chevron" />
          <span className={clsx("diff-file__status", `diff-file__status--${file.status}`)} title={statusLabels[file.status]}>
            <StatusIcon size={15} aria-hidden="true" />
            <span className="sr-only">{statusLabels[file.status]}: </span>
          </span>
          <span className="diff-file__path" title={renamedFrom ? `${renamedFrom} → ${file.path}` : file.path}>
            {renamedFrom && (
              <>
                <span className="diff-file__old-path">{renamedFrom}</span>
                <span aria-hidden="true"> → </span>
                <span className="sr-only"> renamed to </span>
              </>
            )}
            {file.path}
          </span>
          {file.binary && <span className="badge">Binary</span>}
          {file.truncated && <span className="badge badge--warning">Truncated</span>}
          <DiffStat additions={file.additions} deletions={file.deletions} />
        </button>
      </h3>
      {open && (
        <div id={bodyId} className="diff-file__body">
          {file.binary ? (
            <p className="diff-file__note">Binary file. Its contents are not shown.</p>
          ) : !hasHunks ? (
            <p className="diff-file__note">No line changes to show.</p>
          ) : view === "split" ? (
            <SplitHunks path={file.path} hunks={file.hunks} />
          ) : (
            <UnifiedHunks path={file.path} hunks={file.hunks} />
          )}
          {file.truncated && (
            <p className="diff-file__note diff-file__note--warning">
              This diff was shortened to keep the view fast. Some lines are not shown.
            </p>
          )}
        </div>
      )}
    </section>
  );
});
