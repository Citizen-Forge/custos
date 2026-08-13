// Agent records: CRUD, fallback-set migration, and the built-in-role
// bootstrap, backed by a single agents.json JsonCollection. Widely
// consumed via `import * as agentStore from "./agents.js"` across the
// orchestrator, routes, and slack modules, so this stays a re-export
// barrel over ./agents/ rather than a namespace those call sites would
// need to update.
//
// Split by concern: agents/store.ts (the JsonCollection singleton +
// read path + backfill migrations -- every other sub-module imports
// the singleton from here), agents/mutate.ts (create/update/delete),
// agents/migrate.ts (the fallback-set schema migration, self-contained),
// agents/provider-options.ts (pure, the EM's dispatchable-model menu),
// agents/bootstrap.ts (seeds a project's built-in role agents).
export {
  agents,
  emptyStats,
  backfillKind,
  backfillPersona,
  listAgents,
  getAgent,
  displayName,
  findRoleAgent,
  listEngineers,
  primaryPick,
  type PrimaryPick,
} from "./agents/store.js";

export {
  createAgent,
  updateAgent,
  appendAgentNote,
  recordAssignment,
  recordRunResult,
  deleteAgent,
  deleteProjectAgents,
  type CreateAgentInput,
  type AgentPatch,
} from "./agents/mutate.js";

export { migrateToFallbackSets } from "./agents/migrate.js";

export { listProviderOptions, type ProviderOption } from "./agents/provider-options.js";

export { ensureProjectAgents, defaultFallbackSetForGlobal } from "./agents/bootstrap.js";
