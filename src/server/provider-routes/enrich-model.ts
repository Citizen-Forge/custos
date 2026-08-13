/** Shared model-metadata enrichment. Given a raw upstream model object
 *  from any provider's /v1/models response, extract known fields across
 *  different provider schemas and return the `inferred` capacity block
 *  plus any `pricing`. Shared between the unsaved-instance probe
 *  (POST /admin/api/instances/probe-models) and the saved-provider probe
 *  (POST /admin/api/providers/:name/probe-models) so the inference logic
 *  lives in one place and doesn't drift. */
export function enrichModel(m: Record<string, unknown>): {
  id: string;
  owned_by: unknown;
  created: unknown;
  inferred?: { maxOutputTokens?: number; maxContextWindow?: number };
  pricing?: { inputPerMillion: number; outputPerMillion: number };
} {
  const id = String(m.id ?? m.name ?? "");
  const inferred: { maxOutputTokens?: number; maxContextWindow?: number } = {};
  if (typeof m.context_window === "number") inferred.maxContextWindow = m.context_window;
  if (typeof m.max_completion_tokens === "number") inferred.maxOutputTokens = m.max_completion_tokens;
  if (typeof m.context_length === "number") inferred.maxContextWindow = m.context_length;
  if (typeof m.max_tokens === "number" && inferred.maxOutputTokens === undefined) {
    inferred.maxOutputTokens = m.max_tokens;
  }
  const pricing = m.pricing && typeof m.pricing === "object"
    ? { inputPerMillion: Number((m.pricing as Record<string, unknown>).input ?? 0), outputPerMillion: Number((m.pricing as Record<string, unknown>).output ?? 0) }
    : undefined;
  return {
    id,
    owned_by: m.owned_by ?? null,
    created: m.created ?? null,
    inferred: Object.keys(inferred).length > 0 ? inferred : undefined,
    ...(pricing ? { pricing } : {}),
  };
}
