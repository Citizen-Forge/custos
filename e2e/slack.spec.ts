import { test, expect, type Page } from "@playwright/test";

async function login(page: Page): Promise<void> {
  await page.goto("/login?next=/admin");
  await page.locator("#password").fill("e2e-test-password");
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/\/admin$/);
}

function slackPanel(page: Page) {
  return page.locator("section.panel", { has: page.locator("h2", { hasText: "Slack" }) });
}

async function expandSlackPanel(page: Page): Promise<void> {
  const panel = slackPanel(page);
  if (await panel.evaluate((el) => el.classList.contains("collapsed"))) {
    await panel.locator("h2").click();
  }
  await expect(panel.locator('input[type="checkbox"]')).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await login(page);
  await expandSlackPanel(page);
});

test("shows not configured on a fresh instance, enabled by default", async ({ page }) => {
  const panel = slackPanel(page);
  await expect(panel.locator('input[type="checkbox"]')).toBeChecked();
  await expect(panel).toContainText("not configured -- the integration stays inactive");
});

test("disabling then re-enabling persists across reload", async ({ page }) => {
  const toggle = slackPanel(page).locator('input[type="checkbox"]');

  await toggle.click();
  await expect(page.locator("#toast")).toContainText("Slack integration disabled");
  await page.reload();
  await expandSlackPanel(page);
  await expect(slackPanel(page).locator('input[type="checkbox"]')).not.toBeChecked();

  await slackPanel(page).locator('input[type="checkbox"]').click();
  await expect(page.locator("#toast")).toContainText("Slack integration enabled");
  await page.reload();
  await expandSlackPanel(page);
  await expect(slackPanel(page).locator('input[type="checkbox"]')).toBeChecked();
});

test("saving a bot token updates the configured status", async ({ page }) => {
  const panel = slackPanel(page);
  await panel.locator('input[type="password"]').fill("xoxb-e2e-test-token-0000000000-abcdefghijklmnop");
  await panel.locator("button", { hasText: "Save" }).click();
  await expect(page.locator("#toast")).toContainText("Slack bot token saved");

  await page.reload();
  await expandSlackPanel(page);
  await expect(slackPanel(page)).toContainText(/configured \(/);

  // Clean up so a re-run of this suite starts from "not configured" again.
  await slackPanel(page).locator("button", { hasText: "Clear" }).click();
  await expect(page.locator("#toast")).toContainText("Slack bot token cleared");
});
