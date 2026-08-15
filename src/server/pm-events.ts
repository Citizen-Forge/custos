import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import type { Orchestrator } from "../pm/orchestrator.js";

/**
 * Push channel for the roadmap, board and devops tabs.
 *
 * Deliberately notification-only: a frame says "this project changed" or
 * carries a line for the activity feed, and the client refetches. Agent
 * runs mutate several stores at once (a ticket's status, its comments, an
 * agent's stats, the run log), and pushing diffs for all of that would mean
 * maintaining a second, subtly different view of state on the client. A
 * refetch is one extra round trip and is always right.
 */
export function registerPmEventRoutes(app: FastifyInstance, orchestrator: Orchestrator): void {
  const clients = new Map<WebSocket, string>();

  const send = (projectId: string, payload: unknown): void => {
    const frame = JSON.stringify(payload);
    for (const [socket, watching] of clients) {
      if (watching !== projectId) continue;
      if (socket.readyState === socket.OPEN) socket.send(frame);
    }
  };

  orchestrator.on("change", (projectId) => send(projectId, { type: "pm_change", projectId }));
  // .text is the third-person operator-facing line -- the UI toast's wire
  // format is unchanged from before ActivityMessage existed. See
  // orchestrator.ts's ActivityMessage doc comment: .slackText/.agent are
  // for slack/activity.ts's first-person rendering only.
  orchestrator.on("activity", (projectId, message) => send(projectId, { type: "pm_activity", projectId, message: message.text, at: Date.now() }));

  app.get("/admin/api/pm/ws", { websocket: true }, (socket, req) => {
    const { projectId } = req.query as { projectId?: string };
    if (!projectId) {
      socket.close(4001, "projectId is required");
      return;
    }
    clients.set(socket, projectId);
    socket.send(JSON.stringify({ type: "connected", projectId }));
    socket.on("close", () => clients.delete(socket));
    socket.on("error", () => clients.delete(socket));
  });
}
