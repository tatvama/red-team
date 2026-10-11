# syntax=docker/dockerfile:1.7
# Tatvam Agent container image.
#   docker build -t tatvam-agent:0.1.0 .
# Runs as a non-root user, works with a read-only root filesystem, and supports the arbitrary
# UIDs OpenShift assigns (all writable paths are group 0 and group-writable).

ARG NODE_IMAGE=node:24-bookworm-slim

FROM ${NODE_IMAGE} AS deps
WORKDIR /app
RUN npm install -g pnpm@10.34.6
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1 NEXT_OUTPUT=standalone
RUN pnpm build

FROM ${NODE_IMAGE} AS runtime
# git powers worktrees, diffs and checkpoints; tini reaps child processes (MCP servers, commands).
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates tini \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --uid 10001 --gid 0 --home-dir /data --no-create-home tatvam \
  && mkdir -p /data /app \
  && chown -R 10001:0 /data /app \
  && chmod -R g=u /data /app

WORKDIR /app
COPY --from=build --chown=10001:0 /app/.next/standalone ./
COPY --from=build --chown=10001:0 /app/.next/static ./.next/static
COPY --from=build --chown=10001:0 /app/scripts/mock-llm.mjs ./scripts/mock-llm.mjs
# Built-in evaluation suites and their fixtures (override the location with EVALS_DIR).
COPY --from=build --chown=10001:0 /app/evals ./evals

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/data \
    HOME=/data \
    COMMAND_RUNNER=off

USER 10001
EXPOSE 3000
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.js"]
