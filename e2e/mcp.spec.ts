import { test, expect, type Page } from "@playwright/test";

async function login(page: Page): Promise<void> {
  await page.goto("/login?next=/admin");
  await page.locator("#password").fill("e2e-test-password");
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/\/admin$/);
}

function mcpPanel(page: Page) {
  return page.locator("section.panel", { has: page.locator("h2", { hasText: "MCP server" }) });
}

async function expandMcpPanel(page: Page): Promise<void> {
  const panel = mcpPanel(page);
  if (await panel.evaluate((el) => el.classList.contains("collapsed"))) {
    await panel.locator("h2").click();
  }
  await expect(panel.locator("input[readonly]").first()).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await login(page);
  await expandMcpPanel(page);
});

test("shows no key generated on a fresh instance", async ({ page }) => {
  await expect(mcpPanel(page).locator(".badge.off")).toContainText("No key generated");
  await expect(mcpPanel(page).locator("button", { hasText: "Generate key" })).toBeVisible();
});

test("generating then revoking a key updates status and persists", async ({ page }) => {
  const panel = mcpPanel(page);
  await panel.locator("button", { hasText: "Generate key" }).click();

  await expect(panel.locator(".badge.ok")).toContainText("Key configured");
  // The freshly-generated key is revealed exactly once, inline.
  await expect(panel.locator("#mcp-key-reveal input")).toBeVisible();

  await page.reload();
  await expandMcpPanel(page);
  await expect(mcpPanel(page).locator(".badge.ok")).toContainText("Key configured");
  // Reveal box is a one-time display, not persisted state.
  await expect(mcpPanel(page).locator("#mcp-key-reveal input")).toHaveCount(0);

  page.once("dialog", (dialog) => dialog.accept());
  await mcpPanel(page).locator("button", { hasText: "Revoke" }).click();
  await expect(page.locator("#toast")).toContainText("MCP key revoked");

  await page.reload();
  await expandMcpPanel(page);
  await expect(mcpPanel(page).locator(".badge.off")).toContainText("No key generated");
});
