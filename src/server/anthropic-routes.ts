import type { FastifyInstance } from "fastify";
import type { Runtime } from "../runtime.js";
import { getApiKeySource } from "../config.js";
import { startOAuthFlow, exchangeCode, type OAuthMode } from "../auth/oauth.js";
import { getOAuthStatus, saveTokens, clearTokens } from "../auth/credentials.js";
import { OAuthFlowTracker } from "../auth/oauth-flow-tracker.js";
import { maskApiKey, updateConfig } from "./admin-shared.js";

export function registerAnthropicRoutes(app: FastifyInstance, runtime: Runtime): void {
  const oauthFlows = new OAuthFlowTracker();

  app.put("/admin/api/anthropic", async (req, reply) => {
    const { apiKey, maxConcurrent, rpmLimit } = req.body as { apiKey?: string | null; maxConcurrent?: number | null; rpmLimit?: number | null };
    if (maxConcurrent !== undefined && maxConcurrent !== null && (!Number.isInteger(maxConcurrent) || maxConcurrent < 1)) {
      reply.code(400);
      return { error: "maxConcurrent must be a positive integer (or null for unlimited)" };
    }
    if (rpmLimit !== undefined && rpmLimit !== null && (!Number.isInteger(rpmLimit) || rpmLimit < 1)) {
      reply.code(400);
      return { error: "rpmLimit must be a positive integer (or null for unlimited)" };
    }
    const config = await updateConfig(runtime, (cfg) => ({
      ...cfg,
      anthropic: {
        ...cfg.anthropic,
        ...(apiKey !== undefined ? { apiKey: apiKey || undefined } : {}),
        ...(maxConcurrent !== undefined ? { maxConcurrent: maxConcurrent ?? undefined } : {}),
        ...(rpmLimit !== undefined ? { rpmLimit: rpmLimit ?? undefined } : {}),
      },
    }));
    const result: Record<string, unknown> = {};
    if (apiKey !== undefined) {
      result.apiKeySource = await getApiKeySource();
      result.apiKeyMasked = config.anthropic?.apiKey ? maskApiKey(config.anthropic.apiKey) : null;
    }
    return { ok: true, ...result };
  });

  // Keep the old endpoint for backward compat.
  app.put("/admin/api/anthropic-key", async (req, reply) => {
    const { apiKey } = req.body as { apiKey: string | null };
    const config = await updateConfig(runtime, (cfg) => ({
      ...cfg,
      anthropic: { ...cfg.anthropic, apiKey: apiKey || undefined },
    }));
    return { apiKeySource: await getApiKeySource(), apiKeyMasked: config.anthropic?.apiKey ? maskApiKey(config.anthropic.apiKey) : null };
  });

  app.post("/admin/api/oauth/start", async (req, reply) => {
    const { mode } = req.body as { mode: OAuthMode };
    if (mode !== "max" && mode !== "console") {
      reply.code(400);
      return { error: "mode must be \"max\" or \"console\"" };
    }
    const flow = startOAuthFlow(mode);
    const flowId = oauthFlows.create(flow);
    return { flowId, authorizationUrl: flow.authorizationUrl };
  });

  app.post("/admin/api/oauth/complete", async (req, reply) => {
    const { flowId, code } = req.body as { flowId: string; code: string };
    const flow = oauthFlows.consume(flowId);
    if (!flow) {
      reply.code(400);
      return { error: "OAuth flow not found or expired -- start over" };
    }
    try {
      const tokens = await exchangeCode(code, flow);
      await saveTokens(tokens);
    } catch (err) {
      reply.code(400);
      return { error: (err as Error).message };
    }
    return { ok: true, oauth: await getOAuthStatus() };
  });

  app.post("/admin/api/oauth/disconnect", async () => {
    await clearTokens();
    return { ok: true, oauth: await getOAuthStatus() };
  });
}
