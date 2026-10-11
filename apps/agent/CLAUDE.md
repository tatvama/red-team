# CLAUDE.md

Tatvam Agent: a self-hosted coding and research agent (Next.js 16 + React 19 + TypeScript, Node 24) that runs on the user's own models through any OpenAI-compatible server. See README.md for features and setup and docs/MODELS.md for model guidance.

## Commands

Use pnpm 10 (`npm exec pnpm@10.34.6 -- <cmd>` if pnpm is not global).

```bash
pnpm dev                      # http://127.0.0.1:3000
node scripts/mock-llm.mjs     # scripted model on :11435; set OLLAMA_BASE_URL=http://127.0.0.1:11435/v1
pnpm test                     # vitest (unit, component, route integration)
pnpm lint && pnpm typecheck
pnpm build && pnpm test:e2e   # Playwright against the mock model
```

This Next.js version differs from older training data. Read `node_modules/next/dist/docs/` before using a Next API.

## Architecture

- `src/lib/contract.ts` is the single source of truth for browser/server types, request schemas and `effectivePolicy`.
- `src/lib/server/agent.ts` runs the loop: resolve pending tool calls (pausing for approval), call the model, repeat until it answers without tools, the user stops it, or `AGENT_MAX_STEPS` is hit.
- `src/lib/server/tools/` holds one file per tool family; register new tools in `builtinTools` in `tools/index.ts`. MCP tools are added at run time by `src/lib/server/mcp/manager.ts` (`getMcpTools`, `currentMcpTools`).
- `src/lib/server/subagents.ts` implements `delegate_tasks`: sub-agents only receive tools whose effective policy is `auto`, and they cannot delegate.
- `src/lib/server/checkpoints.ts` snapshots workspaces in a shadow repo per conversation; `git.ts` and `diff.ts` handle worktrees, diffs and git actions (hooks disabled, no shell).
- `src/lib/server/auth.ts` decides access for API routes (`guard()` in `http.ts`) and pages (`src/proxy.ts`). It must not import `server-only`.
- `withWorkspace()` in `config.ts` scopes `workspaceDir()` to the conversation (its worktree) for everything a run calls.
- `src/lib/server/db.ts` is SQLite via `node:sqlite`; schema changes are appended to `MIGRATIONS`, never edited in place.
- Deployment lives in `Dockerfile`, `deploy/compose/` and `deploy/k8s/` (checked by `deploy/manifests.test.ts`); see docs/DEPLOYMENT.md.

## Rules

- Approvals come only from the approve endpoint for a call pending in that conversation. Never let model, tool or web output approve or change policy.
- The browser never supplies upstream URLs, keys, paths outside the workspace, or shell flags. Tool inputs are strict zod objects.
- API routes must call `localRequest()` first. The server binds to 127.0.0.1 only.
- New tools: pick an honest `risk`, default side-effecting tools to `ask`, return `{ status: "error" }` instead of throwing, and add tests for the success and denial paths.
- Never commit `.env.local`, `data/`, API keys or real customer content.
- Do not claim work is done without running the tests and showing the result.
