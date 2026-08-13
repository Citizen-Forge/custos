import type { FastifyInstance } from "fastify";
import type { Orchestrator } from "../../pm/orchestrator.js";
import { getProject } from "../../remote/projects.js";
import { updateSettings } from "../../pm/project-settings.js";
import { notFound } from "./shared.js";

export function registerLifecycleRoutes(app: FastifyInstance, orchestrator: Orchestrator): void {
  /** Stops this project dead: aborts every running agent and blocks further
   * dispatch until resumed. Persisted, so it survives a restart. */
  app.post("/admin/api/projects/:id/pause", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!(await getProject(id))) return notFound(reply, "project");
    const aborted = await orchestrator.pauseProject(id);
    return { ok: true, aborted };
  });

  app.post("/admin/api/projects/:id/resume", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!(await getProject(id))) return notFound(reply, "project");
    await orchestrator.resumeProject(id);
    return { ok: true };
  });

  /** Resets pmConfigured so the Project Manager re-evaluates model
   * assignments on the next tick. Useful after editing providers or
   * changing the budget cap. Returns immediately; the PM runs in the
   * background. */
  app.post("/admin/api/projects/:id/reassign-models", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!(await getProject(id))) return notFound(reply, "project");
    await updateSettings(id, { pmConfigured: false });
    void orchestrator.assignModels(id);
    return { ok: true };
  });

  /** Flips pmConfigured to false so the Project Manager re-evaluates
   * model assignments on its NEXT tick -- deferring to the existing
   * tick cadence instead of forcing a synchronous assignment pass.
   * Distinct from /reassign-models: that endpoint actively runs
   * assignModels() now (costs one PM call right away); this endpoint
   * leaves the choice to the orchestrator's normal 20s pass. Use after
   * editing providers, the project's budget, or the agent model menu
   * -- anywhere a config change should be picked up but the existing
   * PM work doesn't need to be re-done right this second. The orchestrator
   * gate at tickProject() reads !settings.pmConfigured and triggers
   * assignModels() on its own; no explicit call here. */
  app.post("/admin/api/projects/:id/reset-pm", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!(await getProject(id))) return notFound(reply, "project");
    await updateSettings(id, { pmConfigured: false });
    // Operator-visible feedback in the activity feed: the reset is
    // immediate but the actual reassignment happens on the next tick,
    // so an explicit "reset requested" entry makes the gap visible.
    orchestrator.emit("activity", id, "Project Manager reset — will re-evaluate on next tick.");
    return { ok: true };
  });
}
