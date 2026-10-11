import { defineConfig, devices } from "@playwright/test";

// End-to-end tests run the production build against the scripted mock model, with a throwaway
// data directory, so they need no GPU, no Ollama and no network. Run `pnpm build` first.
const dataDir = "test-results/e2e-data";
// Uses the installed Google Chrome by default, so no browser download is needed.
// Set PLAYWRIGHT_CHANNEL= (empty) to use Playwright's own Chromium after `npx playwright install chromium`.
const channel = (process.env.PLAYWRIGHT_CHANNEL ?? "chrome") || undefined;

export default defineConfig({
  testDir: "tests/e2e",
  testMatch: "*.spec.ts",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: "list",
  use: { baseURL: "http://127.0.0.1:3100", trace: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], channel } },
    { name: "mobile", use: { ...devices["Pixel 7"], channel } },
  ],
  webServer: [
    {
      command: "node scripts/mock-llm.mjs",
      url: "http://127.0.0.1:11436/v1/models",
      env: { MOCK_LLM_PORT: "11436" },
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: "node scripts/e2e-reset.mjs && node node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port 3100",
      url: "http://127.0.0.1:3100",
      env: {
        OLLAMA_BASE_URL: "http://127.0.0.1:11436/v1",
        GPU_BASE_URL: "",
        DATA_DIR: dataDir,
        WORKSPACE_DIR: `${dataDir}/workspace`,
        COMMAND_RUNNER: "off",
        SEARCH_PROVIDER: "",
        BRAVE_API_KEY: "",
        TAVILY_API_KEY: "",
        SEARXNG_URL: "",
      },
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
