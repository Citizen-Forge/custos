import { test, expect, type Page } from "@playwright/test";

async function login(page: Page): Promise<void> {
  await page.goto("/login?next=/admin");
  await page.locator("#password").fill("e2e-test-password");
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/\/admin$/);
}

function globalServicesPanel(page: Page) {
  return page.locator("section.panel", { has: page.locator("h2", { hasText: "Global services" }) });
}

async function expandGlobalServicesPanel(page: Page): Promise<void> {
  const panel = globalServicesPanel(page);
  if (await panel.evaluate((el) => el.classList.contains("collapsed"))) {
    await panel.locator("h2").click();
  }
  await expect(panel.locator("table.providers-table")).toBeVisible();
}

function serviceRow(page: Page, label: string) {
  return globalServicesPanel(page).locator("tr", { has: page.locator("strong", { hasText: new RegExp(`^${label}$`) }) });
}

test.beforeEach(async ({ page }) => {
  await login(page);
  await expandGlobalServicesPanel(page);
});

test("shows the seeded global services", async ({ page }) => {
  await expect(serviceRow(page, "Memory curator")).toBeVisible();
  await expect(serviceRow(page, "Permission classifier")).toBeVisible();
  await expect(serviceRow(page, "Embeddings")).toBeVisible();
});

test("changing a service's fallback set persists across reload", async ({ page }) => {
  // ensureGlobalAgents seeds Memory curator on "standard" -- see
  // pm/global-agents.ts. Round-trips to "fast" and back so the run leaves
  // the service in its originally-seeded state either way.
  const row = serviceRow(page, "Memory curator");
  const select = row.locator("select");
  await expect(select).toHaveValue("standard");

  await select.selectOption("fast");
  await row.locator("button", { hasText: "Save" }).click();
  await expect(page.locator("#toast")).toContainText("Memory curator updated");
  await page.reload();
  await expandGlobalServicesPanel(page);
  await expect(serviceRow(page, "Memory curator").locator("select")).toHaveValue("fast");

  await serviceRow(page, "Memory curator").locator("select").selectOption("standard");
  await serviceRow(page, "Memory curator").locator("button", { hasText: "Save" }).click();
  await expect(page.locator("#toast")).toContainText("Memory curator updated");
  await page.reload();
  await expandGlobalServicesPanel(page);
  await expect(serviceRow(page, "Memory curator").locator("select")).toHaveValue("standard");
});
