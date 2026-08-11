import { test, expect, type Page } from "@playwright/test";

async function login(page: Page): Promise<void> {
  await page.goto("/login?next=/admin");
  await page.locator("#password").fill("e2e-test-password");
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/\/admin$/);
}

function projectsPanel(page: Page) {
  return page.locator("section.panel", { has: page.locator("h2", { hasText: "Projects" }) });
}

async function expandProjectsPanel(page: Page): Promise<void> {
  const panel = projectsPanel(page);
  if (await panel.evaluate((el) => el.classList.contains("collapsed"))) {
    await panel.locator("h2").click();
  }
  await expect(panel.locator("button", { hasText: "New project" })).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await login(page);
  await expandProjectsPanel(page);
});

test("shows the empty state on a fresh instance", async ({ page }) => {
  await expect(projectsPanel(page)).toContainText("No projects yet.");
});

test("creating a project via the New project prompt shows it in the list", async ({ page }) => {
  const name = "E2E Test Project";
  page.once("dialog", (dialog) => dialog.accept(name));
  await projectsPanel(page).locator("button", { hasText: "New project" }).click();

  const row = projectsPanel(page).locator("tr", { has: page.locator("strong", { hasText: name }) });
  await expect(row).toBeVisible();

  // No delete affordance exists in the admin UI (projects are meant to be
  // durable) -- clean up through the same DELETE route the backend
  // exposes, using the page's own authenticated session.
  const created = await page.evaluate(async (projectName) => {
    const res = await fetch("/admin/api/projects");
    const data = await res.json();
    return (data.projects || []).find((p: { name: string }) => p.name === projectName);
  }, name);
  expect(created).toBeTruthy();
  const del = await page.request.delete(`/admin/api/projects/${created.id}`);
  expect(del.ok()).toBe(true);
});
