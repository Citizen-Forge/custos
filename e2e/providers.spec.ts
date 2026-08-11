import { test, expect, type Page } from "@playwright/test";

/**
 * Coverage for the admin.html "Model providers" panel -- the exact surface
 * that broke in production (a provider toggled off, then a second admin
 * click intended to re-enable it toggled it right back off; see the
 * fallback-set "unregistered" state and the double-toggle investigation
 * this test locks in). Every panel on this page is collapsed by default
 * (state persisted in localStorage), so each test expands it before
 * asserting on the table.
 */

async function login(page: Page): Promise<void> {
  await page.goto("/login?next=/admin");
  await page.locator("#password").fill("e2e-test-password");
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/\/admin$/);
}

// Scoped to this one panel -- the Global Services panel further down the
// page reuses the same `providers-table` class on an unrelated table
// (services -> fallback sets), so an unscoped page-wide locator matches
// both and Playwright's strict mode rejects the ambiguity.
function providersPanel(page: Page) {
  return page.locator("section.panel", { has: page.locator("h2", { hasText: "Model providers" }) });
}

async function expandProvidersPanel(page: Page): Promise<void> {
  const panel = providersPanel(page);
  if (await panel.evaluate((el) => el.classList.contains("collapsed"))) {
    await panel.locator("h2").click();
  }
  await expect(panel.locator("table.providers-table")).toBeVisible();
}

function providerRow(page: Page, name: string) {
  // Exact match: "ollama" as a substring also matches the "ollama-fast"
  // row, and Playwright's default `hasText` is a substring test.
  return providersPanel(page).locator("tr.provider-row", { has: page.locator("strong", { hasText: new RegExp(`^${name}$`) }) });
}

test.beforeEach(async ({ page }) => {
  await login(page);
  await expandProvidersPanel(page);
});

test("shows the default providers", async ({ page }) => {
  await expect(providerRow(page, "ollama")).toBeVisible();
  await expect(providerRow(page, "ollama-fast")).toBeVisible();
});

test("disabling then re-enabling a provider persists across reload", async ({ page }) => {
  const row = providerRow(page, "ollama-fast");
  const toggle = row.locator('input[type="checkbox"]');
  await expect(toggle).toBeChecked();

  // Disable -- a single click, matching exactly how an operator uses the
  // switch (the production incident was two clicks in quick succession
  // fighting each other, not the toggle itself misbehaving on one click).
  await toggle.click();
  await expect(page.locator("#toast")).toContainText("ollama-fast disabled");
  await page.reload();
  await expandProvidersPanel(page);
  await expect(providerRow(page, "ollama-fast").locator('input[type="checkbox"]')).not.toBeChecked();

  // Re-enable and confirm that sticks too -- this is the exact direction
  // that broke: a provider coming back OFF after an operator's enable click.
  await providerRow(page, "ollama-fast").locator('input[type="checkbox"]').click();
  await expect(page.locator("#toast")).toContainText("ollama-fast enabled");
  await page.reload();
  await expandProvidersPanel(page);
  await expect(providerRow(page, "ollama-fast").locator('input[type="checkbox"]')).toBeChecked();
});
