import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

// Runs against the production build and scripts/mock-llm.mjs (see playwright.config.ts).
// The mock calls write_file for prompts containing "write" and update_plan for "plan".

const composer = (page: Page) => page.getByRole("textbox", { name: "Message" });

async function send(page: Page, text: string) {
  await composer(page).fill(text);
  await composer(page).press("Enter");
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: /Model: mock-agent/ })).toBeVisible();
});

test("streams a reply with reasoning and markdown, then moves to the conversation URL", async ({ page }) => {
  await send(page, "hello from the e2e test");
  await expect(page.getByText("Mock reply.").first()).toBeVisible();
  await expect(page.getByText(/Thought for/).first()).toBeVisible();
  await expect(page.getByText("const ready = true;")).toBeVisible();
  await expect(page).toHaveURL(/\/c\/[0-9a-f-]{36}$/);
});

test("waits for approval before writing a file, then writes it", async ({ page }) => {
  await send(page, "write the greeting file");
  const approve = page.getByRole("button", { name: "Approve", exact: true });
  await expect(approve).toBeVisible();
  await approve.click();
  await expect(page.getByText(/Wrote 18 B/).first()).toBeVisible();
  expect(readFileSync("test-results/e2e-data/workspace/hello.txt", "utf8")).toBe("Hello from Tatvam\n");
});

test("records a denial without running the tool", async ({ page }) => {
  await send(page, "write something please");
  await page.getByRole("button", { name: "Deny", exact: true }).click();
  await expect(page.getByText("Denied", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve", exact: true })).toHaveCount(0);
});

test("shows the plan as the agent updates it", async ({ page }) => {
  await send(page, "make a plan first");
  // The plan renders as a right rail on wide screens and a bar above the composer on narrow ones.
  await expect(page.getByText("1 of 3").filter({ visible: true }).first()).toBeVisible();
  await expect(page.getByText("Make the change").filter({ visible: true }).first()).toBeVisible();
});

test("plan-only mode never offers file edits", async ({ page }) => {
  await page.getByRole("button", { name: /Permission mode/ }).click();
  await page.getByText("Plan only", { exact: true }).click();
  await expect(page.getByRole("button", { name: /Permission mode: Plan only/ })).toBeVisible();
  await send(page, "write the file anyway");
  await expect(page.getByText("Mock reply.").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve", exact: true })).toHaveCount(0);
});

test("the API refuses cross-origin requests", async ({ request }) => {
  const response = await request.get("/api/conversations", { headers: { Origin: "https://evil.example" } });
  expect(response.status()).toBe(403);
});
