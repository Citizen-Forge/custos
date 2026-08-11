import { defineConfig, devices } from "@playwright/test";

// Isolated from the real data/ directory (never touches production config,
// credentials, or the on-disk board/agent state) -- see GATEWAY_CONFIG_PATH
// / GATEWAY_AUTH_PATH in config.ts / admin-session.ts. Playwright's
// webServer starts and tears down the gateway around the test run, so this
// is disposable per invocation; .e2e-data/ is gitignored.
const PORT = 8799;
const DATA_DIR = ".e2e-data/data";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: {
    command: "npx tsx src/index.ts",
    url: `http://localhost:${PORT}/login`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    env: {
      PORT: String(PORT),
      GATEWAY_CONFIG_PATH: `${DATA_DIR}/config.json`,
      GATEWAY_AUTH_PATH: `${DATA_DIR}/auth.json`,
      // Without this, credentials.ts falls back to the real repo-local
      // data/credentials.json -- on a dev machine that's actively used for
      // real OAuth testing, that file can hold a real (possibly expired)
      // token set, and syncSpawnedSessionCredentials would try to mirror
      // it into the developer's actual ~/.claude/.credentials.json on
      // every boot. Pointing at the isolated dir means there's nothing to
      // load, so the sync short-circuits at "skipped" before it ever
      // touches anything outside .e2e-data/.
      GATEWAY_CREDENTIALS_PATH: `${DATA_DIR}/credentials.json`,
      ADMIN_PASSWORD: "e2e-test-password",
      CUSTOS_WORKSPACE_DIR: ".e2e-data/workspace",
      // No real OAuth session exists in this throwaway data dir, and the
      // periodic refresh timer has nothing to do here -- disabling it
      // (0 = off, see runtime.ts's startMirrorRefresh disable contract)
      // avoids a dangling interval and console noise unrelated to what
      // these tests are checking.
      MIRROR_REFRESH_INTERVAL_MS: "0",
    },
  },
});
