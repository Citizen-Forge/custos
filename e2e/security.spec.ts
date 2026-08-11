import { test, expect, type Page } from "@playwright/test";

const ORIGINAL_PASSWORD = "e2e-test-password";

async function login(page: Page, password = ORIGINAL_PASSWORD): Promise<void> {
  await page.goto("/login?next=/admin");
  await page.locator("#password").fill(password);
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/\/admin$/);
}

function securityPanel(page: Page) {
  return page.locator("section.panel", { has: page.locator("h2", { hasText: "Security" }) });
}

async function expandSecurityPanel(page: Page): Promise<void> {
  const panel = securityPanel(page);
  if (await panel.evaluate((el) => el.classList.contains("collapsed"))) {
    await panel.locator("h2").click();
  }
  await expect(panel.locator("button", { hasText: "Change password" })).toBeVisible();
}

async function changePassword(page: Page, current: string, next: string): Promise<void> {
  const panel = securityPanel(page);
  await panel.locator('input[placeholder="Current password"]').fill(current);
  await panel.locator('input[placeholder^="New password"]').fill(next);
  await panel.locator("button", { hasText: "Change password" }).click();
}

// Every other spec in this suite logs in with ORIGINAL_PASSWORD, so this
// test must leave it unchanged regardless of how it exits -- the
// try/finally restores it even if an assertion above throws first.
test("changing the admin password takes effect, then is restored", async ({ page }) => {
  await login(page);
  await expandSecurityPanel(page);

  const TEMP_PASSWORD = "e2e-temp-password-123";
  try {
    await changePassword(page, ORIGINAL_PASSWORD, TEMP_PASSWORD);
    await expect(page.locator("#toast")).toContainText("Password changed");

    // Old password should now be rejected, new one accepted.
    await page.context().clearCookies();
    await page.goto("/login?next=/admin");
    await page.locator("#password").fill(ORIGINAL_PASSWORD);
    await page.locator('button[type="submit"]').click();
    await expect(page.locator("#error")).toContainText("Wrong password");

    await login(page, TEMP_PASSWORD);
    await expandSecurityPanel(page);
  } finally {
    await changePassword(page, TEMP_PASSWORD, ORIGINAL_PASSWORD);
    await expect(page.locator("#toast")).toContainText("Password changed");
  }
});
