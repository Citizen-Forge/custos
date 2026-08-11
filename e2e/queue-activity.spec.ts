import { test, expect, type Page } from "@playwright/test";

async function login(page: Page): Promise<void> {
  await page.goto("/login?next=/admin");
  await page.locator("#password").fill("e2e-test-password");
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/\/admin$/);
}

function queueActivityPanel(page: Page) {
  return page.locator("section.panel", { has: page.locator("h2", { hasText: "Queue activity" }) });
}

async function expandQueueActivityPanel(page: Page): Promise<void> {
  const panel = queueActivityPanel(page);
  if (await panel.evaluate((el) => el.classList.contains("collapsed"))) {
    await panel.locator("h2").click();
  }
  await expect(panel.locator("table.activity-table")).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await login(page);
  await expandQueueActivityPanel(page);
});

test("shows the empty state when nothing has dispatched yet", async ({ page }) => {
  await expect(queueActivityPanel(page)).toContainText("No queue activity yet");
});

test("outcome filter buttons toggle the active style", async ({ page }) => {
  const panel = queueActivityPanel(page);
  // Exact match: "fallback" contains "all" as a substring, and
  // Playwright's default hasText string match is a case-insensitive
  // substring test -- {hasText: "All"} matches the "↪ fallback" button too.
  const allBtn = panel.locator("button", { hasText: /^All$/ });
  const succeededBtn = panel.locator("button", { hasText: /succeeded/ });

  // "All" starts active -- accent background is how setActiveFilter marks it.
  await expect(allBtn).toHaveCSS("background-color", /.+/);
  const allBg = await allBtn.evaluate((el) => getComputedStyle(el).backgroundColor);

  await succeededBtn.click();
  const succeededBg = await succeededBtn.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(succeededBg).toBe(allBg); // same accent color now applied to the newly-active button
  const allBgAfter = await allBtn.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(allBgAfter).not.toBe(allBg); // and cleared from the previously-active one
});
