// Starts the scripted mock model and the dev server wired to it, with a separate data folder.
//   pnpm dev:mock                 →   http://127.0.0.1:3000
//   pnpm dev:mock -- --port 3210  →   another port
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { port: { type: "string" } } });

const env = {
  ...process.env,
  OLLAMA_BASE_URL: "http://127.0.0.1:11435/v1",
  MOCK_LLM_PORT: "11435",
  DATA_DIR: process.env.DATA_DIR ?? "data/mock",
};
const port = values.port ?? process.env.PORT ?? "3000";

const mock = spawn(process.execPath, ["scripts/mock-llm.mjs"], { stdio: "inherit", env });
const app = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--hostname", "127.0.0.1", "--port", port], {
  stdio: "inherit",
  env,
});

const stop = () => {
  mock.kill();
  app.kill();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
app.on("exit", (code) => {
  mock.kill();
  process.exit(code ?? 0);
});
mock.on("exit", (code) => {
  if (code) app.kill();
});
