// Cross-platform wrapper around `npx tsx --test src/providers/fixtures.test.ts`
// that injects `VENDOR=<vendor-id>` into the child process env. Used by
// package.json's per-vendor scripts (`test:gemini`, `test:openrouter`,
// ...) so env propagation isn't dependent on bash-only inline
// `VAR=value cmd` syntax (which fails on Windows cmd.exe with
// `'VENDOR' is not recognized as an internal or external command`).
//
// Usage:
//   node scripts/run-vendor-test.mjs <vendor-id>
//
// <vendor-id> must match the JSON filename in `src/providers/fixtures/`
// (sans `.json` extension), e.g. `gemini`, `openrouter`, `bedrock`,
// `raw_openai`. The matrix only loads fixtures whose filename is the
// vendor id verbatim or starts with `<vendor-id>-`.

import { spawnSync } from "node:child_process";

const vendor = process.argv[2];
if (!vendor) {
  console.error("usage: node scripts/run-vendor-test.mjs <vendor-id>");
  process.exit(2);
}

// Mirrors what developers type by hand: `npx tsx --test ...`. On
// Windows, `npx` resolves to a `.cmd` shim which Windows requires
// a shell to interpret -- without `shell: true`, spawnSync returns
// silently and `stdio: "inherit"` carries no output. POSIX shells
// accept the unquoted form fine too. `shell: true` lets env={ VENDOR }
// propagate cleanly to the child in either case. Args are static
// (no user input), so the shell-quoting risk is zero.
const npx = process.platform === "win32" ? "npx.cmd" : "npx";

const result = spawnSync(npx, ["tsx", "--test", "src/providers/fixtures.test.ts"], {
  stdio: "inherit",
  env: { ...process.env, VENDOR: vendor },
  shell: true,
});

process.exit(result.status ?? 1);
