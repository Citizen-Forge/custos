import type { AgentRole } from "../types.js";

/** Fallback set each built-in role starts on. The steering team uses the
 * strongest available set. Everything else defaults to "complex" and the
 * Project Manager re-assigns based on budget and availability after the
 * first tick. */
export const ROLE_DEFAULT_FALLBACK_SET: Record<AgentRole, string> = {
  steering: "complex",
  "product-owner": "complex",
  "engineering-manager": "complex",
  engineer: "standard",
  qa: "standard",
  devops: "standard",
  "project-manager": "complex",
};

/** Fallback set each built-in global system role defaults to. Distinct
 *  from ROLE_DEFAULT_FALLBACK_SET because global services aren't picked
 *  by the Project Manager -- they're config-time seeds that operate
 *  project-orthogonally. Each global gets its OWN fallback set rather
 *  than sharing "standard" / "fast" with project agents: embeddings
 *  need an embedding-capable model (not a chat model -- Ollama's
 *  /api/embeddings rejects chat-model names), the permission
 *  classifier wants the smallest reliable JSON-only model, and the
 *  memory curator benefits from a strong reasoning set. Sharing a set
 *  with project agents would silently misroute these services whenever
 *  an operator edits the shared set's first entry. The matching
 *  `embeddings` and `classifier` sets are defined in
 *  DEFAULT_CONFIG.fallbackSets (config/defaults.ts). */
export const GLOBAL_AGENT_FALLBACK_SET = {
  memoryCurator: "standard",
  permissionClassifier: "classifier",
  embeddings: "embeddings",
} as const;

/** @deprecated Kept for backward compat — the PM now assigns fallback sets,
 *  not specific providerKey/model pairs. Use ROLE_DEFAULT_FALLBACK_SET. */
export const ROLE_DEFAULT_MODEL: Record<AgentRole, [providerKey: string, model: string]> = {
  steering: ["anthropic", "claude-opus-5"],
  "product-owner": ["anthropic", "claude-sonnet-5"],
  "engineering-manager": ["anthropic", "claude-sonnet-5"],
  engineer: ["anthropic", "claude-sonnet-5"],
  qa: ["anthropic", "claude-sonnet-5"],
  devops: ["anthropic", "claude-sonnet-5"],
  "project-manager": ["anthropic", "claude-sonnet-5"],
};
