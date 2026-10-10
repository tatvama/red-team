"use client";

import clsx from "clsx";
import {
  Bot,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleStop,
  FlaskConical,
  Globe,
  LoaderCircle,
  type LucideIcon,
  Search,
  ShieldCheck,
} from "lucide-react";
import { memo, useId, useState } from "react";
import type { SubagentRole, SubagentView } from "@/lib/contract";
import { Markdown } from "./markdown";

const roleLabels: Record<SubagentRole, string> = {
  researcher: "Researcher",
  reviewer: "Reviewer",
  tester: "Tester",
  general: "Sub-agent",
};

const roleIcons: Record<Exclude<SubagentRole, "researcher">, LucideIcon> = {
  reviewer: ShieldCheck,
  tester: FlaskConical,
  general: Bot,
};

function RoleIcon({ role }: { role: SubagentRole }) {
  if (role === "researcher") {
    // A globe with a magnifier: research on the web.
    return (
      <span className="role-icon" aria-hidden="true">
        <Globe size={16} />
        <Search size={10} className="role-icon__badge" strokeWidth={3} />
      </span>
    );
  }
  const Icon = roleIcons[role] ?? Bot;
  return <Icon size={16} aria-hidden="true" />;
}

const statusInfo: Record<SubagentView["status"], { label: string; icon: LucideIcon; chip: string }> = {
  running: { label: "Running", icon: LoaderCircle, chip: "running" },
  done: { label: "Done", icon: CircleCheck, chip: "ok" },
  error: { label: "Error", icon: CircleAlert, chip: "error" },
  stopped: { label: "Stopped", icon: CircleStop, chip: "denied" },
};

function SubagentStatus({ status }: { status: SubagentView["status"] }) {
  const info = statusInfo[status] ?? statusInfo.running;
  const Icon = info.icon;
  return (
    <span className={clsx("status-chip", `status-chip--${info.chip}`)}>
      <Icon size={13} aria-hidden="true" className={status === "running" ? "spin" : undefined} />
      {info.label}
    </span>
  );
}

export const SubagentCard = memo(function SubagentCard({ subagent }: { subagent: SubagentView }) {
  const [reportOpen, setReportOpen] = useState(false);
  const baseId = useId();
  const { role, task, status, steps, activity, report } = subagent;

  return (
    <article className={clsx("subagent-card", `subagent-card--${status}`)} aria-labelledby={`${baseId}-task`}>
      <header className="subagent-card__head">
        <span className={clsx("subagent-card__icon", `subagent-card__icon--${role}`)}>
          <RoleIcon role={role} />
        </span>
        <span className="subagent-card__role">{roleLabels[role] ?? roleLabels.general}</span>
        <SubagentStatus status={status} />
      </header>
      <p id={`${baseId}-task`} className="subagent-card__task" title={task}>
        {task}
      </p>
      <p className="subagent-card__meta">
        <span>{steps === 1 ? "1 step" : `${steps} steps`}</span>
        {status === "running" && activity && (
          <>
            <span aria-hidden="true"> · </span>
            <span className="subagent-card__activity" title={activity}>
              {activity}
            </span>
          </>
        )}
      </p>
      {report && (
        <>
          <button
            type="button"
            className="subagent-card__toggle"
            aria-expanded={reportOpen}
            aria-controls={`${baseId}-report`}
            onClick={() => setReportOpen(!reportOpen)}
          >
            <ChevronRight size={13} aria-hidden="true" className="subagent-card__chevron" />
            {status === "error" ? (reportOpen ? "Hide error" : "Show error") : reportOpen ? "Hide report" : "Show report"}
          </button>
          {reportOpen && (
            <div id={`${baseId}-report`} className="subagent-card__report">
              <Markdown text={report} />
            </div>
          )}
        </>
      )}
    </article>
  );
});

/** The sub-agents one `delegate_tasks` call started, in the order they were created. */
export function SubagentGrid({ subagents }: { subagents: SubagentView[] }) {
  if (subagents.length === 0) return null;
  const running = subagents.filter((subagent) => subagent.status === "running").length;
  return (
    <section className="subagents" aria-label={`Sub-agents: ${subagents.length}, ${running} running`}>
      <div className="subagent-grid">
        {subagents.map((subagent) => (
          <SubagentCard key={subagent.id} subagent={subagent} />
        ))}
      </div>
    </section>
  );
}
