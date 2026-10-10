# Tatvam Agent

A self-hosted AI agent for coding, research and everyday work, in the spirit of Claude Code and Codex, running on **your own models**.
It thinks out loud, asks before it acts, edits files, runs commands, searches the web and keeps a live plan. Your conversations and keys stay on your machine.

## What it does

| Capability | How |
| --- | --- |
| **Thinking** | Streams the model's reasoning (`reasoning_content`, `reasoning` or `<think>` blocks) into a collapsible panel. |
| **Authorization** | Four permission modes (Ask, Accept edits, Plan only, Full auto), per-tool policies (auto / ask / off) and approval cards with Approve, Always allow in this chat, or Deny. |
| **Agentic coding** | `list_files`, `read_file`, `search_files`, `edit_file`, `write_file` inside a workspace folder, plus `run_command` for tests and builds. |
| **Execution** | Shell commands in a locked-down Docker container (no network, no capabilities, read-only root) or on the host. Off by default. |
| **Planning** | `update_plan` keeps a visible checklist that updates as the agent works. |
| **Web** | `web_search` (SearXNG, Brave or Tavily) and `web_fetch` with SSRF protection. |
| **Sub-agents** | `delegate_tasks` runs up to 6 researcher, reviewer, tester or general sub-agents in parallel, each with a fresh context, with live progress cards. They only get tools your permission mode already auto-approves. |
| **Checkpoints** | Every file edit and command is snapshotted first, in a separate shadow repository that never touches your git history. Restore files to any point, or rewind files and conversation together. |
| **Git review** | Run a task in its own git worktree and branch, review a structured diff (unified or split), then commit, push, open a GitHub pull request, merge or discard from the UI. |
| **MCP** | Connect any MCP server (stdio or Streamable HTTP) through `mcp.json`. Its tools go through the same approvals; enable, disable or restart servers in Settings. |
| **Memory** | `save_memory` / `forget_memory`. Memories appear in every conversation and can be removed in Settings. |
| **Utilities** | `calculator`, `get_current_time`. |
| **Models** | Any OpenAI-compatible server: Ollama locally, vLLM or similar on a GPU server. Models without tool support fall back to plain chat. |
| **Deployment** | Docker image, a GPU compose file with vLLM, and Kubernetes manifests with an OpenShift overlay. Remote access uses signed sessions. See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). |

## Quick start

Requires Node 24 and pnpm 10 (`npm exec pnpm@10.34.6 -- <command>` works without a global install).

```bash
pnpm install
cp .env.example .env.local
pnpm dev
```

Open http://127.0.0.1:3000. Choose a model from the picker under the message box.

### Try it with no GPU (mock model)

`scripts/mock-llm.mjs` is a scripted OpenAI-compatible server for development. It streams reasoning, text and tool calls. One command starts it together with the app, using a separate `data/mock` folder:

```bash
pnpm dev:mock
```

Choose **mock-agent** in the model picker. Prompts containing "plan", "list", "write" or "run" trigger the matching tools, so you can try approvals end to end.

### Local models with Ollama

1. Install Ollama and pull a model that supports tools, for example `ollama pull qwen3:8b`.
2. Give it enough context for agent work: set `OLLAMA_CONTEXT_LENGTH=32768` for the Ollama server and `CONTEXT_TOKENS=32000` here.
3. Keep the default `OLLAMA_BASE_URL=http://127.0.0.1:11434/v1`.

### Your GPU server

Serve a model with an OpenAI-compatible API, for example vLLM:

```bash
vllm serve <model> --api-key <secret> --max-model-len 65536 \
  --enable-auto-tool-choice --tool-call-parser <parser-for-your-model> \
  --reasoning-parser <parser-for-your-model>
```

Then in `.env.local`:

```bash
GPU_BASE_URL=https://your-gpu-host/v1
GPU_API_KEY=<secret>
CONTEXT_TOKENS=64000
```

Do not expose the vLLM port to the internet. Put it behind TLS on a private network, or use an SSH tunnel (`ssh -L 8000:127.0.0.1:8000 gpu-host` and `GPU_BASE_URL=http://127.0.0.1:8000/v1`). See [docs/MODELS.md](docs/MODELS.md) for choosing, serving and fine-tuning models.

### Let it run commands

Commands are off until you choose a runner:

- `COMMAND_RUNNER=docker` (recommended). Each command runs in a fresh container with the workspace mounted at `/workspace`, no network (`SANDBOX_NETWORK=true` to allow it), all capabilities dropped and memory, CPU and process limits.
- `COMMAND_RUNNER=host`. Commands run on this machine in the workspace folder, through PowerShell on Windows and bash elsewhere, with API keys stripped from the environment. Keep the permission mode on **Ask** when you use this.

Set `WORKSPACE_DIR` to the project you want the agent to work on. Never point it at the Tatvam folder itself, which holds `.env.local` and the database. Host mode is not a sandbox: a command runs with your user's rights and can read any file you can.

## Safety model

- **Approvals come only from you.** The approve endpoint accepts a decision only for a call that is pending in that conversation, from a same-origin request. Model output, tool output, MCP results, sub-agent reports and web pages cannot approve anything. Sub-agents never ask; they only get tools that already run automatically.
- **Local by default.** The API answers same-origin requests addressed to `127.0.0.1` or `localhost`, which also blocks DNS rebinding. Other host names work only when listed in `ALLOWED_HOSTS` with `ACCESS_TOKEN` set, and then require a signed session (see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)).
- **Undo is always there.** Edits and commands are checkpointed in a shadow repository before they run.
- **Repository metadata is protected.** File tools refuse to write inside `.git`, and the Docker sandbox mounts `.git` read-only. Git commands started from the UI (commit, push, merge) run with hooks disabled, because hook files in the working tree could have been written by the agent. Run your hooks or linters as a step in the task, or commit from your own terminal.
- **No upstream URLs from the browser.** The browser names a provider (`ollama` or `gpu`). URLs and keys come only from server environment variables.
- **Workspace jail.** File tools reject absolute paths, `..` escapes and symlink escapes.
- **SSRF protection.** `web_fetch` resolves DNS at connect time and refuses private, loopback, link-local and reserved addresses, including after redirects.
- **Untrusted content.** Tool results and web pages are labelled as data. The system prompt tells the model never to follow instructions found in them.

## Configuration

All settings are environment variables. See [.env.example](.env.example) for the full list with explanations. Tool policies, custom instructions and memories are managed in the app's Settings dialog and stored in `DATA_DIR/tatvam.db`.

## Development

```bash
pnpm test            # unit and component tests (vitest)
pnpm lint
pnpm typecheck
pnpm build && pnpm test:e2e   # end-to-end tests against the mock model
```

Layout:

```
src/app/                 pages and API route handlers
src/components/          the interface
src/lib/contract.ts      types and schemas shared by browser and server
src/lib/client/          browser state, streaming reader, API helpers
src/lib/server/agent.ts  the agent loop: model call → tool calls → approvals → repeat
src/lib/server/llm.ts    OpenAI-compatible streaming client (reasoning + tool calls)
src/lib/server/db.ts     SQLite store (node:sqlite)
src/lib/server/tools/    one file per tool family
scripts/mock-llm.mjs     scripted model server for development and tests
```

### Connect MCP servers

Create `data/mcp.json` (or point `MCP_CONFIG` at a file). It uses the same format as Claude Desktop:

```json
{
  "mcpServers": {
    "files": { "command": "node", "args": ["path/to/server.js"] },
    "remote": { "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer ${env:MY_TOKEN}" } }
  }
}
```

`${env:NAME}` reads secrets from the environment, so they never sit in the file. Servers can only be added by editing this file; the browser can enable, disable or restart them. Every MCP tool starts on **ask**.

## Roadmap

- Image input for vision models, and document upload with retrieval
- Browser automation tool for testing web apps
- Multiple workspaces and users with roles
- CLI and VS Code clients on the same API
- Export approved conversations as fine-tuning data
