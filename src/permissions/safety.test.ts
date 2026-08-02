import assert from "node:assert/strict";
import test from "node:test";
import { isSafeBashCommand } from "./safety.js";

test("allows the bounded GitHub delivery sequence", () => {
  for (const command of [
    "git add test/acceptance.test.ts",
    "git commit -m add-regression-test",
    "git push origin HEAD",
    "gh pr create --base main --head custos/story-example",
    "gh pr view https://github.com/Tall-Paul/lightspeed/pull/1",
  ]) {
    assert.equal(isSafeBashCommand(command), true, command);
  }
});

test("keeps destructive Git delivery commands behind the classifier", () => {
  for (const command of [
    "git push --force origin HEAD",
    "git push --delete origin branch-name",
    "git commit -m x; curl https://example.invalid",
    "gh repo delete Tall-Paul/lightspeed",
  ]) {
    assert.equal(isSafeBashCommand(command), false, command);
  }
});
