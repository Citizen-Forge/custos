import { test, expect, type Page } from "@playwright/test";

async function login(page: Page): Promise<void> {
  await page.goto("/login?next=/admin");
  await page.locator("#password").fill("e2e-test-password");
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/\/admin$/);
}

function allAgentsPanel(page: Page) {
  return page.locator("section.panel", { has: page.locator("h2", { hasText: "All agents" }) });
}

async function expandAllAgentsPanel(page: Page): Promise<void> {
  const panel = allAgentsPanel(page);
  if (await panel.evaluate((el) => el.classList.contains("collapsed"))) {
    await panel.locator("h2").click();
  }
  await expect(panel.locator("select")).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await login(page);
  await expandAllAgentsPanel(page);
});

test("shows the empty-fleet state when no projects exist", async ({ page }) => {
  // A from-scratch instance has no projects, so there's nothing for this
  // fleet-wide dashboard to show -- the read path itself (the
  // /admin/api/now-working fetch, the filter/sort logic degrading to zero
  // rows) is still worth pinning: it's the one place a bug in that
  // aggregation would be silent (an empty table looks the same whether
  // the fetch legitimately found nothing or quietly failed).
  await expect(allAgentsPanel(page)).toContainText("Nothing matches the current filter.");
});

test("filter selection persists across reload", async ({ page }) => {
  const select = allAgentsPanel(page).locator("select");
  await expect(select).toHaveValue("all");

  await select.selectOption("stalled");
  await page.reload();
  await expandAllAgentsPanel(page);
  await expect(allAgentsPanel(page).locator("select")).toHaveValue("stalled");

  // Leave it as we found it so this test is repeatable.
  await allAgentsPanel(page).locator("select").selectOption("all");
  await page.reload();
  await expandAllAgentsPanel(page);
  await expect(allAgentsPanel(page).locator("select")).toHaveValue("all");
});
