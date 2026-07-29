import type { FastifyInstance } from "fastify";
import type { Runtime } from "../runtime.js";
import { getApiKeySource } from "../config.js";
import { startOAuthFlow, exchangeCode, type OAuthMode } from "../auth/oauth.js";
import { OAuthFlowTracker } from "../auth/oauth-flow-tracker.js";
import { getValidAccessToken, getOAuthStatus, saveTokens, clearTokens } from "../auth/credentials.js";
import { maskApiKey, resolveApiKey, updateConfig } from "./admin-shared.js";

export function registerAnthropicRoutes(app: FastifyInstance, runtime: Runtime): void {
  const oauthFlows = new OAuthFlowTracker();
  app.addHook("onClose", async () => {
    oauthFlows.stop();
  });

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
        apiKey: resolveApiKey(apiKey, cfg.anthropic?.apiKey),
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
      anthropic: { ...cfg.anthropic, apiKey: resolveApiKey(apiKey, cfg.anthropic?.apiKey) },
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

  app.post("/admin/api/anthropic/probe", async () => {
    const accessToken = await getValidAccessToken().catch(() => null);
    const apiKey = runtime.config?.anthropic?.apiKey;

    if (!accessToken && !apiKey) {
      return { ok: false, error: "No OAuth session and no API key configured" };
    }

    const authHeaders: Record<string, string> = {};
    if (accessToken) {
      authHeaders.authorization = `Bearer ${accessToken}`;
      authHeaders["anthropic-beta"] = "oauth-2025-04-20";
    } else if (apiKey) {
      authHeaders["x-api-key"] = apiKey;
    }

    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        signal: AbortSignal.timeout(10000),
        headers: {
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
          ...authHeaders,
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1,
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      return { ok: true, status: res.status, statusText: res.statusText };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });
}
