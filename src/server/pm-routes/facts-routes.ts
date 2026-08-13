import type { FastifyInstance } from "fastify";
import * as facts from "../../pm/facts.js";
import { notFound } from "./shared.js";

export function registerFactsRoutes(app: FastifyInstance): void {
  app.get("/admin/api/projects/:id/facts", async (req) => {
    const { id } = req.params as { id: string };
    return { facts: await facts.listFacts(id) };
  });

  app.post("/admin/api/projects/:id/facts", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { key, value, category } = (req.body ?? {}) as { key?: string; value?: string; category?: facts.FactCategory };
    if (!key?.trim() || !value?.trim()) {
      reply.code(400);
      return { error: "key and value are required" };
    }
    return { fact: await facts.writeFact({ projectId: id, key: key.trim(), value: value.trim(), category }) };
  });

  app.delete("/admin/api/facts/:factId", async (req, reply) => {
    const { factId } = req.params as { factId: string };
    if (!(await facts.deleteFact(factId))) return notFound(reply, "fact");
    return { ok: true };
  });
}
