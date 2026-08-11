import { test, expect, type Page } from "@playwright/test";

async function login(page: Page): Promise<void> {
  await page.goto("/login?next=/admin");
  await page.locator("#password").fill("e2e-test-password");
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/\/admin$/);
}

function fallbackSetsPanel(page: Page) {
  return page.locator("section.panel", { has: page.locator("h2", { hasText: "Fallback sets" }) });
}

async function expandFallbackSetsPanel(page: Page): Promise<void> {
  const panel = fallbackSetsPanel(page);
  if (await panel.evaluate((el) => el.classList.contains("collapsed"))) {
    await panel.locator("h2").click();
  }
  // The health table only renders once /admin/api/runtime/stats has come
  // back on the initial page load -- the "Add or update" form below it is
  // always present, so wait on that instead of the (possibly-empty)
  // health table.
  await expect(panel.locator("input.fs-set-name")).toBeVisible();
}

function healthRow(page: Page, name: string) {
  return fallbackSetsPanel(page).locator("tr", { has: page.locator("strong", { hasText: new RegExp(`^${name}$`) }) });
}

test.beforeEach(async ({ page }) => {
  await login(page);
  await expandFallbackSetsPanel(page);
});

test("shows the default fallback sets", async ({ page }) => {
  await expect(healthRow(page, "complex")).toBeVisible();
  await expect(healthRow(page, "standard")).toBeVisible();
  await expect(healthRow(page, "fast")).toBeVisible();
});

test("creating a fallback set persists across reload, then deletes cleanly", async ({ page }) => {
  const panel = fallbackSetsPanel(page);
  const setName = "e2e-test-set";

  await panel.locator("input.fs-set-name").fill(setName);
  await panel.locator("input.fs-desc").fill("Created by the E2E suite");
  await panel.locator("button", { hasText: "+ Add provider" }).click();

  const entryRow = panel.locator(".fs-entry-row").last();
  await entryRow.locator("select").first().selectOption("ollama");
  await entryRow.locator("select").nth(1).selectOption("qwen2.5:14b-instruct-q4_K_M");

  await panel.locator("button.primary", { hasText: "Save" }).click();
  await expect(page.locator("#toast")).toContainText("Fallback set saved");

  await page.reload();
  await expandFallbackSetsPanel(page);
  const created = healthRow(page, setName);
  await expect(created).toBeVisible();
  await expect(created).toContainText("ollama/qwen2.5:14b-instruct-q4_K_M");

  await created.locator("button", { hasText: "Delete" }).click();
  await expect(page.locator("#toast")).toContainText(`Removed "${setName}"`);
  await expect(healthRow(page, setName)).toHaveCount(0);

  // Confirm the delete actually persisted, not just the in-memory render.
  await page.reload();
  await expandFallbackSetsPanel(page);
  await expect(healthRow(page, setName)).toHaveCount(0);
});
