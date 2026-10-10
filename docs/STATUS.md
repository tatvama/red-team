# Project Status

> Read this first in every session. Update it before you end a session (the `/handoff` skill does this).
> Plan: [`docs/PLAN.md`](PLAN.md). Spec: [`docs/spec/TATVAM_AI_RED_TEAM_IMPLEMENTATION.md`](spec/TATVAM_AI_RED_TEAM_IMPLEMENTATION.md).

**Last updated:** 2026-10-10
**Current phase:** M0 scaffold implemented in the m0-scaffold worktree; local app checks pass. Docker verification and the separate threat-model slice remain.

---

## Next up, in order

1. Review the committed scaffold in `D:\Projects\red-team-worktrees\m0-scaffold` (`feat/m0-scaffold`). Follow its README; the main checkout remains the integration baseline.
2. Run `infra/compose.dev.yaml` on Docker and obtain infrastructure/security review. Docker is not installed on this machine.
3. Complete `docs/m0-threat-model`: threat model, ADRs, control matrix, forbid-list and authorization template.
4. Decide D2 (OIDC provider) and D3 (scope signers/reviewers), then implement M1 schema, identity and scope lifecycle. D1 is needed before GPU provisioning in M2.
5. Resolve the artifact-store distribution choice: official MinIO images no longer resolve; the optional overlay requires a reviewed image.
6. Configure branch protection and CODEOWNERS once a security reviewer is named.

---

## Branches and worktrees

Worktrees are sibling folders: `D:\Projects\red-team-worktrees\<folder>`. They are local only, so recreate them on a new machine with the `/resume` skill.

| Branch                 | Worktree folder        | Status                            | Notes                                                                   |
| ---------------------- | ---------------------- | --------------------------------- | ----------------------------------------------------------------------- |
| `main`                 | `D:\Projects\red-team` | Bootstrap merged                  | Integration branch                                                      |
| `feat/m0-scaffold`     | `m0-scaffold`          | Committed locally; review pending | 16 API/topology tests, 18 web tests, 4 browser tests; Docker unverified |
| `docs/m0-threat-model` | `m0-threat-model`      | Not started                       | Docs only                                                               |
| `feat/policy-core`     | `policy-core`          | Not started                       | Pure policy, no infra                                                   |
| `feat/agent-app`       | `agent-app`            | In progress                       | Internal developer agent in `apps/agent`, PLAN 1.1 carve-out; PR open   |

---

## Open decisions (PLAN section 3)

| ID  | Decision                              | Status                                                                                           |
| --- | ------------------------------------- | ------------------------------------------------------------------------------------------------ |
| D1  | GPU host provider and terms           | Pending                                                                                          |
| D2  | Identity provider                     | Pending, Keycloak recommended for dev                                                            |
| D3  | Who signs and reviews customer scopes | Pending                                                                                          |
| D4  | Model choice                          | Pending, benchmark in M2                                                                         |
| D5  | Worker isolation                      | Pending                                                                                          |
| D6  | Off-host backup destination           | Pending                                                                                          |
| D7  | Permitted lab and staging targets     | Pending                                                                                          |
| D8  | Retention periods                     | Pending                                                                                          |
| D9  | Repo visibility                       | Public at the owner's request. The first push had not landed; `main` and `feat/agent-app` were pushed 2026-10-10, other branches are local only. Revisit before any engagement data exists |

---

## Environment notes

- Dev machine: Windows 11, Git Bash and PowerShell. Node 24.15 present. Bundled Python 3.12.14 and pnpm are available. The scaffold has a local uv 0.13.0 and virtual environment; pinned pnpm 10.34.6 is invoked via npm exec. Docker is still missing.
- Global git setting `core.autocrlf=true`. The repo's `.gitattributes` forces LF, so do not remove it.
- Remote: `https://github.com/tatvama/red-team`.

---

## Session log

Append one line per session, newest last: date, branch, what changed, what is next.

- 2026-10-10, `main`: Cloned the empty repo. Added spec, PLAN, CLAUDE.md, STATUS, repo skeleton, env example, Claude skills for resume, new-slice and handoff. Created three worktree branches and pushed all branches. Next: install prerequisites, start M0.

- 2026-10-10, `feat/m0-scaffold`: Implemented scaffold foundation, dashboard, liveness API, strict safety settings, generated contracts, Alembic initialization, development services and CI. Local validation: 16 Python/topology tests (100% current API coverage), 18 web tests, 4 browser tests, build/lint/types/secret scan and real API smoke. Implementation validated locally. Docker was unavailable; MinIO distribution needs a reviewed image. Next: infrastructure review and the threat-model slice.

- 2026-10-10, `feat/m0-scaffold`: Committed the foundation at the user's request. Existing validation: 38 tests passed, build/lint/types and secret checks passed; Docker runtime verification remains pending. Not pushed.

- 2026-10-10, `feat/agent-app`: Added the internal developer agent (Tatvam Agent) as `apps/agent` under a new PLAN 1.1 carve-out decided by the owner. 570 unit/integration and 22 end-to-end tests pass; lint, types and production build clean. Docker image and Kubernetes manifests are statically checked only. Next: security review of the carve-out and PR. Note: the `m0-scaffold` worktree is checked out on `codex/agent-chat` with uncommitted Codex chat files; restore it to `feat/m0-scaffold` before M0 work.
