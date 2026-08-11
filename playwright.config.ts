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
  // All specs share one webServer instance and one JSON-file-backed data
  // store (see webServer.env below) -- there's no per-test database
  // transaction to isolate concurrent writers, so cross-file parallelism
  // risks two tests' PATCH/PUT calls landing on the same on-disk file at
  // once. Config-mutating admin-panel coverage is inherently this kind of
  // integration test, not an independent-unit-test suite; run serially.
  workers: 1,
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
      // Every one of these defaults to a path under the real repo-local
      // data/ directory (see the GATEWAY_*_PATH / GATEWAY_*_DIR constants
      // across src/). On a dev machine that's actually been used to run
      // custos for real, that directory holds real projects, a real MCP
      // key, real chats, real spend/vault state -- discovered the hard way
      // when "shows no key generated on a fresh instance" failed against
      // an MCP key this machine had generated months ago, because
      // GATEWAY_MCP_AUTH_PATH wasn't in this list. Redirecting all of them
      // under .e2e-data/ is what actually makes a test run disposable and
      // read-only with respect to real local state; missing even one
      // means a "fresh instance" test can read (or write) production data.
      GATEWAY_CONFIG_PATH: `${DATA_DIR}/config.json`,
      GATEWAY_AUTH_PATH: `${DATA_DIR}/auth.json`,
      GATEWAY_CREDENTIALS_PATH: `${DATA_DIR}/credentials.json`,
      GATEWAY_MCP_AUTH_PATH: `${DATA_DIR}/mcp-auth.json`,
      GATEWAY_SESSIONS_DIR: `${DATA_DIR}/sessions`,
      GATEWAY_CURATOR_CURSOR_PATH: `${DATA_DIR}/curator-cursor.json`,
      GATEWAY_ASK_OUTCOMES_PATH: `${DATA_DIR}/ask-outcomes.jsonl`,
      GATEWAY_PM_DIR: `${DATA_DIR}/pm`,
      GATEWAY_VAULT_KEY_PATH: `${DATA_DIR}/vault.key`,
      GATEWAY_SPEND_PATH: `${DATA_DIR}/spend.json`,
      GATEWAY_CHATS_PATH: `${DATA_DIR}/chats.json`,
      GATEWAY_PROJECTS_PATH: `${DATA_DIR}/projects.json`,
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
