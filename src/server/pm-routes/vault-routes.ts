// Deliberately write-only: there is no endpoint that returns a stored
// value, for any caller, ever. A secret goes in once and after that only
// its name, description and last four characters are readable. If you've
// lost the value, replace it -- that's the intended path, not a gap.
import type { FastifyInstance } from "fastify";
import * as vault from "../../pm/vault.js";
import { notFound } from "./shared.js";

export function registerVaultRoutes(app: FastifyInstance): void {
  app.get("/admin/api/projects/:id/secrets", async (req) => {
    const { id } = req.params as { id: string };
    return { secrets: await vault.listSecrets(id) };
  });

  app.get("/admin/api/secrets", async () => {
    return { secrets: await vault.listSecrets() };
  });

  app.post("/admin/api/secrets", async (req, reply) => {
    const body = (req.body ?? {}) as vault.CreateSecretInput;
    try {
      return { secret: await vault.createSecret(body) };
    } catch (err) {
      reply.code(400);
      return { error: (err as Error).message };
    }
  });

  app.patch("/admin/api/secrets/:secretId", async (req, reply) => {
    const { secretId } = req.params as { secretId: string };
    const secret = await vault.updateSecret(secretId, (req.body ?? {}) as vault.UpdateSecretInput);
    if (!secret) return notFound(reply, "secret");
    return { secret };
  });

  app.delete("/admin/api/secrets/:secretId", async (req, reply) => {
    const { secretId } = req.params as { secretId: string };
    if (!(await vault.deleteSecret(secretId))) return notFound(reply, "secret");
    return { ok: true };
  });
}
