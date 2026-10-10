---
name: new-slice
description: Start a new vertical slice of work on the Tatvam AI Red Team repo as its own branch and git worktree. Use when beginning a milestone slice from docs/PLAN.md, for example feat/m1-db-schema.
argument-hint: <branch-name, e.g. feat/m1-db-schema>
---

# Start a new slice

Argument: the branch name, such as `feat/m1-db-schema`. The worktree folder is the part after the slash, such as `m1-db-schema`.

1. Confirm the slice exists in `docs/PLAN.md` section 4 and note which paths it owns. If it is not in the plan, add it to the plan first and say so.
2. Make sure `main` is current:
   ```bash
   git -C /d/Projects/red-team fetch origin
   git -C /d/Projects/red-team merge --ff-only origin/main
   ```
3. Create the branch and worktree from `main`:
   ```bash
   git -C /d/Projects/red-team worktree add ../red-team-worktrees/<folder> -b <branch> main
   ```
4. Add a row to the worktree table in `docs/STATUS.md` with status `In progress`, commit that on `main` and push `main`.
5. Push the new branch so it exists on GitHub: `git -C /d/Projects/red-team-worktrees/<folder> push -u origin <branch>`.
6. Tell the user the folder path so they can open it as its own Claude Code session, and give the matching prompt from spec section 15.

Rules for the slice: stay inside its owned paths, test both success and denial paths, and keep network-contacting tools disabled unless the M3 gate in PLAN has passed.
