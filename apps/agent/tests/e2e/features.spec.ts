import { existsSync, rmSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

// The advanced features against the production build and the mock model: sub-agents, checkpoint
// restore, the Changes panel, MCP settings and the sign-in page. The e2e workspace is not a git
// repository, which also exercises the "unavailable" paths.

const workspaceFile = "test-results/e2e-data/workspace/hello.txt";
const composer = (page: Page) => page.getByRole("textbox", { name: "Message" });

async function send(page: Page, text: string) {
  await composer(page).fill(text);
  await composer(page).press("Enter");
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: /Model: mock-agent/ })).toBeVisible();
});

test("runs sub-agents in parallel and shows their cards", async ({ page }) => {
  await send(page, "delegate the work");
  await expect(page.getByRole("region", { name: "Sub-agents: 2, 0 running" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Done. The tool reported: `Sub-agent reports (2)").first()).toBeVisible();
});

test("restores files to before an approved edit", async ({ page }) => {
  rmSync(workspaceFile, { force: true });
  await send(page, "write the greeting file");
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(page.getByText(/Wrote 18 B/).first()).toBeVisible();
  expect(existsSync(workspaceFile)).toBe(true);

  await page.getByRole("button", { name: "Restore files to before this" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Restore files" });
  await dialog.getByRole("button", { name: "Restore files" }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => existsSync(workspaceFile)).toBe(false);
});

test("explains when git review is unavailable", async ({ page }) => {
  await send(page, "hello");
  await expect(page.getByText("Mock reply.").first()).toBeVisible();
  await page.getByRole("button", { name: /^Changes/ }).click();
  await expect(page.getByText("The workspace is not a git repository.")).toBeVisible();
});

test("lists MCP servers in settings", async ({ page }) => {
  await page.getByRole("button", { name: "Settings" }).filter({ visible: true }).first().click();
  await page.getByRole("tab", { name: "MCP servers" }).click();
  await expect(page.getByText("No MCP servers are configured.")).toBeVisible();
});

test("serves the sign-in page and reports a local session", async ({ page, request }) => {
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "Sign in to Tatvam" })).toBeVisible();
  const session = await request.get("/api/auth/session");
  expect(await session.json()).toEqual({ remote: false, authenticated: true });
});
