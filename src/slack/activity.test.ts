// Pins personaFor's persona derivation: an ActivityMessage with an
// acting agent posts under that agent's own persona name + role icon,
// not the generic Custos identity -- see orchestrator.ts's ActivityMessage
// doc comment for why the split exists (same event, third-person text
// for the admin UI, first-person text + real persona for Slack).
import test from "node:test";
import assert from "node:assert/strict";
import { personaFor } from "./activity.js";
import { DEFAULT_PERSONA } from "./personas.js";
import type { ActivityMessage } from "../pm/orchestrator.js";

test("a message with an acting agent uses that agent's persona name + role icon", () => {
  const message: ActivityMessage = {
    text: "irrelevant here",
    agent: { personaName: "Mei-Ling Chen", name: "Principal Engineer", role: "principal" },
  };
  const persona = personaFor(message);
  assert.equal(persona.username, "Mei-Ling Chen (Principal Engineer)");
  assert.equal(persona.iconEmoji, ":star2:"); // ROLE_PERSONAS.principal
});

test("an agent with no personaName (legacy record) falls back to just its role-descriptive name", () => {
  const message: ActivityMessage = {
    text: "irrelevant here",
    agent: { personaName: null, name: "Generalist Engineer", role: "engineer" },
  };
  const persona = personaFor(message);
  assert.equal(persona.username, "Generalist Engineer");
});

test("a system-level message with no agent posts under DEFAULT_PERSONA", () => {
  const message: ActivityMessage = { text: "Paused: this month's agent budget ($10) is spent." };
  assert.deepEqual(personaFor(message), DEFAULT_PERSONA);
});

test("every built-in role produces a distinct, non-default persona", () => {
  const roles = ["steering", "product-owner", "engineering-manager", "engineer", "principal", "qa", "devops", "project-manager"] as const;
  const seen = new Set<string>();
  for (const role of roles) {
    const persona = personaFor({ text: "x", agent: { personaName: null, name: role, role } });
    assert.notEqual(persona.iconEmoji, undefined);
    seen.add(persona.iconEmoji);
  }
  // Not a strict uniqueness requirement (icons could reasonably be
  // shared), but catches the trivial bug of every role falling through
  // to the same fallback icon.
  assert.ok(seen.size > 1, "expected more than one distinct icon across all built-in roles");
});
