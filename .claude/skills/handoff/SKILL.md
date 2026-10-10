---
name: handoff
description: End a work session on the Tatvam AI Red Team repo so the next session can continue. Updates docs/STATUS.md, commits, and pushes. Use when the user says wrap up, handoff, save progress, or end session.
---

# Hand off a session

1. Run the tests for whatever changed. Record the command and whether it passed. Do not describe work as done if its tests did not pass.
2. Update `docs/STATUS.md` on the branch you worked on:
   - Set **Last updated** to today and update **Current phase**.
   - Rewrite **Next up** so the first item is the exact next action.
   - Update the worktree table row and any decision whose status changed.
   - Append one line to **Session log**: date, branch, what changed, test result, what is next.
3. If the work was on a slice branch, also update the STATUS row on `main` so `main` always shows overall progress. Keep the session log line identical in both.
4. Check for secrets before committing: no `.env` files, keys, tokens, real scope documents, customer names or evidence. The repo is public.
5. Commit with a clear message and push:
   ```bash
   git -C <worktree-path> add -A
   git -C <worktree-path> commit
   git -C <worktree-path> push
   ```
6. Reply with a short summary: what changed, test result, branch pushed, and the next step.
