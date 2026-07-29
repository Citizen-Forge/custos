import type { FastifyInstance } from "fastify";
import type { Runtime } from "../runtime.js";
import { updateConfig } from "./admin-shared.js";

export function registerFallbackSetRoutes(app: FastifyInstance, runtime: Runtime): void {
  // -- List all fallback sets ---------------------------------------------

  app.get("/admin/api/fallback-sets", async () => {
    return { fallbackSets: runtime.config.fallbackSets ?? {} };
  });

  // -- Create or update a fallback set ------------------------------------

  app.put("/admin/api/fallback-sets/:name", async (req, reply) => {
    const { name } = req.params as { name: string };
    const { description, providers } = req.body as {
      description?: string;
      providers: { provider: string; model: string }[];
    };
    if (!name || !providers?.length) {
      reply.code(400);
      return { error: "name and at least one provider are required" };
    }
    // Validate that every referenced provider exists.
    for (const entry of providers) {
      if (entry.provider !== "anthropic" &&
          !runtime.config.providers?.[entry.provider] &&
          !runtime.config.openaiCompatibleInstances?.[entry.provider]) {
        reply.code(400);
        return { error: `provider "${entry.provider}" is not configured — add it first` };
      }
    }
    const existing = runtime.config.fallbackSets?.[name];
    await updateConfig(runtime, (cfg) => ({
      ...cfg,
      fallbackSets: {
        ...cfg.fallbackSets,
        [name]: {
          name,
          description: description ?? existing?.description ?? "",
          providers,
        },
      },
    }));
    return { ok: true };
  });

  // -- Migrate agents missing fallback sets --------------------------------

  app.post("/admin/api/projects/migrate-fallback-sets", async (_req, reply) => {
    try {
      const { migrateToFallbackSets } = await import("../pm/agents.js");
      const migrated = await migrateToFallbackSets(runtime.config);
      return { ok: true, migrated };
    } catch (err) {
      reply.code(500);
      return { error: (err as Error).message };
    }
  });

  // -- Delete a fallback set ----------------------------------------------

  app.delete("/admin/api/fallback-sets/:name", async (req, reply) => {
    const { name } = req.params as { name: string };
    if (!runtime.config.fallbackSets?.[name]) {
      reply.code(404);
      return { error: `fallback set "${name}" not found` };
    }
    // Check if any agent references this set.
    const { agents } = await import("../pm/agents.js");
    const usages = (await agents.find((a) => a.fallbackSet === name));
    if (usages.length > 0) {
      reply.code(409);
      return {
        error: `"${name}" is used by ${usages.length} agent(s) — reassign those agents first`,
        agentIds: usages.map((a) => a.id),
      };
    }
    await updateConfig(runtime, (cfg) => {
      const { [name]: _removed, ...rest } = cfg.fallbackSets ?? {};
      return { ...cfg, fallbackSets: Object.keys(rest).length > 0 ? rest : undefined };
    });
    return { ok: true };
  });
}
