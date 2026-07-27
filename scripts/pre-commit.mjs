#!/usr/bin/env node
// Pre-commit gate for carrier-strategy changes.
//
// Runs the per-vendor matrix plus the two vendors with the most
// cross-cutting surface -- gemini's thought_signature carrier and
// openrouter's response_root vs message-level merge -- so a
// regression on either placement shows up at commit time rather
// than in CI. Any failure exits non-zero, aborting `git commit`
// before dirty edits land in the carrier.
//
// Activation: `git config core.hooksPath .githooks` once per clone
// (POSIX: also `chmod +x .githooks/pre-commit` so git picks the
// hook up -- no executable bit needed on Windows).
// Skip with `git commit --no-verify` for hot fixes. The body lives
// here so it's testable in isolation from the bridge in
// .githooks/pre-commit.
//
// Step ordering rationale: `test:matrix` already loads ALL fixtures
// end-to-end. The per-vendor `test:gemini` and `test:openrouter`
// steps that follow exercise the same fixtures plus the
// `scripts/run-vendor-test.mjs` cross-platform env-injection wrapper
// -- so a regression in that wrapper slips past the matrix but is
// caught here. Don't drop the per-vendor steps as 'redundant with
// matrix': each one is also an integration test for the wrapper.

import { spawnSync } from "node:child_process";

const STEPS = [
  ["typecheck",         ["npm", "run", "typecheck"]],
  ["matrix",            ["npm", "run", "test:matrix"]],
  ["vendor:gemini",     ["npm", "run", "test:gemini"]],
  ["vendor:openrouter", ["npm", "run", "test:openrouter"]],
];

for (const [name, cmd] of STEPS) {
  console.log(`\n[pre-commit] ${name}: ${cmd.join(" ")}`);
  const result = spawnSync(cmd[0], cmd.slice(1), {
    stdio: "inherit",
    // npm.cmd is a batch file on Windows, so spawnSync needs shell
    // interpretation (same trick as scripts/run-vendor-test.mjs).
    shell: true,
  });
  if (result.status !== 0) {
    console.error(
      `\n[pre-commit] FAIL at "${name}" (exit ${result.status}). ` +
        `Use \`git commit --no-verify\` to bypass for hot fixes.`,
    );
    process.exit(result.status ?? 1);
  }
}

console.log("\n[pre-commit] all carrier-strategy gates passed.");
