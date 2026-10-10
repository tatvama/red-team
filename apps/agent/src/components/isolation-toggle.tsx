"use client";

import { FolderOpen, GitBranch } from "lucide-react";
import { useId } from "react";
import type { Isolation } from "@/lib/contract";
import { Segmented, type SegmentedOption } from "./segmented";

const options: SegmentedOption<Isolation>[] = [
  { value: "shared", label: "Shared", icon: FolderOpen },
  { value: "worktree", label: "Worktree", icon: GitBranch },
];

export const ISOLATION_TIP = "Worktree runs the task on its own git branch in a separate folder.";

type IsolationToggleProps = { value: Isolation; onChange: (value: Isolation) => void; disabled?: boolean };

/** Composer control for a new task in a git workspace: work in the shared folder or in a fresh worktree. */
export function IsolationToggle({ value, onChange, disabled = false }: IsolationToggleProps) {
  const tipId = useId();
  return (
    <div className="isolation tooltip-host">
      <Segmented
        label="Where the task works"
        value={value}
        options={options}
        onChange={onChange}
        compact
        disabled={disabled}
        describedBy={tipId}
      />
      <span id={tipId} role="tooltip" className="tooltip">
        {ISOLATION_TIP}
      </span>
    </div>
  );
}
