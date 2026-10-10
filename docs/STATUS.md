# Project Status

> Read this first in every session. Update it before you end a session (the `/handoff` skill does this).
> Plan: [`docs/PLAN.md`](PLAN.md). Spec: [`docs/spec/TATVAM_AI_RED_TEAM_IMPLEMENTATION.md`](spec/TATVAM_AI_RED_TEAM_IMPLEMENTATION.md).

**Last updated:** 2026-10-10
**Current phase:** Bootstrap complete. Milestone 0 not started.

---

## Next up, in order

1. Install prerequisites on the dev machine: `uv`, Python 3.12, pnpm via `corepack enable pnpm`, Docker Desktop with WSL2.
2. `feat/m0-scaffold`: run spec Prompt A (section 15). Monorepo, CI, dev compose without tool workers.
3. `docs/m0-threat-model`: threat model, ADRs, control matrix, forbid-list, authorization template (PLAN section 4, M0).
4. `feat/policy-core`: pure Policy Decision Point plus the spec 13.1 unit tests. Rebase onto `main` after the scaffold merges.
5. Configure branch protection on `main` and add `CODEOWNERS` once the security reviewer's GitHub handle is known.
6. Decide D1, D2 and D3 before Milestone 1 starts.

---

## Branches and worktrees

Worktrees are sibling folders: `D:\Projects\red-team-worktrees\<folder>`. They are local only, so recreate them on a new machine with the `/resume` skill.

| Branch | Worktree folder | Status | Notes |
|---|---|---|---|
| `main` | `D:\Projects\red-team` | Bootstrap merged | Integration branch |
| `feat/m0-scaffold` | `m0-scaffold` | Not started | Spec Prompt A |
| `docs/m0-threat-model` | `m0-threat-model` | Not started | Docs only |
| `feat/policy-core` | `policy-core` | Not started | Pure policy, no infra |

---

## Open decisions (PLAN section 3)

| ID | Decision | Status |
|---|---|---|
| D1 | GPU host provider and terms | Pending |
| D2 | Identity provider | Pending, Keycloak recommended for dev |
| D3 | Who signs and reviews customer scopes | Pending |
| D4 | Model choice | Pending, benchmark in M2 |
| D5 | Worker isolation | Pending |
| D6 | Off-host backup destination | Pending |
| D7 | Permitted lab and staging targets | Pending |
| D8 | Retention periods | Pending |
| D9 | Repo visibility | Pushed as public on 2026-10-10 at the owner's request. Revisit before any engagement data exists |

---

## Environment notes

- Dev machine: Windows 11, Git Bash and PowerShell. Node 24.15 present. Python, uv, pnpm and Docker missing as of 2026-10-10.
- Global git setting `core.autocrlf=true`. The repo's `.gitattributes` forces LF, so do not remove it.
- Remote: `https://github.com/tatvama/red-team`.

---

## Session log

Append one line per session, newest last: date, branch, what changed, what is next.

- 2026-10-10, `main`: Cloned the empty repo. Added spec, PLAN, CLAUDE.md, STATUS, repo skeleton, env example, Claude skills for resume, new-slice and handoff. Created three worktree branches and pushed all branches. Next: install prerequisites, start M0.
