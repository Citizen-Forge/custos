import type { FastifyInstance } from "fastify";
import type { Runtime } from "../runtime.js";
import { maskApiKey, resolveApiKey, updateConfig } from "./admin-shared.js";

/** Global Slack integration config -- one bot token for the whole gateway,
 *  shared across every project. Per-project channel routing lives on
 *  ProjectSettings.slackChannelId (see pm-routes.ts's existing generic
 *  settings PATCH, which already covers it with no new endpoint needed). */
export function registerSlackRoutes(app: FastifyInstance, runtime: Runtime): void {
  app.put("/admin/api/slack", async (req, reply) => {
    const { botToken, enabled } = req.body as { botToken?: string | null; enabled?: boolean };
    if (enabled !== undefined && typeof enabled !== "boolean") {
      reply.code(400);
      return { error: "enabled must be a boolean" };
    }
    const config = await updateConfig(runtime, (cfg) => ({
      ...cfg,
      slack: {
        ...cfg.slack,
        botToken: resolveApiKey(botToken, cfg.slack?.botToken),
        ...(enabled !== undefined ? { enabled } : {}),
      },
    }));
    return {
      ok: true,
      botTokenConfigured: Boolean(config.slack?.botToken),
      botTokenMasked: config.slack?.botToken ? maskApiKey(config.slack.botToken) : null,
    };
  });
}
