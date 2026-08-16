import type { FastifyInstance } from "fastify";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildMcpServer } from "../mcp/server.js";
import { buildGroomToolsServer, buildAssignToolsServer, buildCurateToolsServer, buildEngineerToolsServer, buildQaToolsServer, lookupSession } from "../mcp/pm-tools.js";
import { verifyMcpKey, getInternalMcpKey } from "../auth/mcp-key.js";
import type { Orchestrator } from "../pm/orchestrator.js";

const JSON_RPC_UNAUTHORIZED = {
  jsonrpc: "2.0",
  error: { code: -32001, message: "Unauthorized -- missing or invalid Authorization: Bearer <key>. Generate a key from the admin panel's MCP section." },
  id: null,
};

const JSON_RPC_METHOD_NOT_ALLOWED = {
  jsonrpc: "2.0",
  error: { code: -32000, message: "Method not allowed." },
  id: null,
};

/**
 * Exposes custos's MCP surface at POST /mcp. Stateless by design
 * (sessionIdGenerator: undefined) -- each request gets a fresh server +
 * transport pair, torn down when the response closes. custos's own tool
 * set (list_projects, create_project, submit_idea) has no need for the
 * resumable-stream/multi-turn session machinery the stateful mode exists
 * for; a client just calls a tool and gets a result.
 *
 * Gated by a bearer token distinct from the admin-session cookie (see
 * auth/mcp-key.ts's doc comment for why) -- this is the one surface in the
 * codebase that lets an external, non-admin-authenticated caller trigger
 * real spend (create_project, submit_idea both kick off paid agent runs),
 * so it gets its own dedicated secret rather than reusing or resurrecting
 * the retired clientApiKey scheme.
 */
export function registerMcpRoutes(app: FastifyInstance, orchestrator: Orchestrator): void {
  app.post("/mcp", async (req, reply) => {
    const auth = req.headers.authorization;
    const bearer = auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length) : undefined;
    // Accept either the operator-generated external key (hashed, see
    // auth/mcp-key.ts) or the process-lifetime internal key a portfolio
    // chat's own spawned subprocess authenticates with when it calls back
    // into this same endpoint over localhost.
    if (bearer !== getInternalMcpKey() && !(await verifyMcpKey(bearer))) {
      reply.code(401);
      return JSON_RPC_UNAUTHORIZED;
    }

    // Hijack so the SDK owns the raw response directly -- StreamableHTTPServerTransport
    // writes its own status/headers/body (including SSE framing for streamed responses),
    // which Fastify's own reply.send() lifecycle isn't built to hand off mid-flight.
    reply.hijack();
    const server = buildMcpServer(orchestrator);
    try {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await server.connect(transport);
      await transport.handleRequest(req.raw, reply.raw, req.body);
      reply.raw.on("close", () => {
        void transport.close();
        void server.close();
      });
    } catch (err) {
      req.log.error({ err }, "MCP request failed");
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { "content-type": "application/json" });
        reply.raw.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null }));
      } else {
        reply.raw.end();
      }
    }
  });

  // The streamable-HTTP transport also defines GET (server-initiated
  // notifications on an existing session) and DELETE (session teardown)
  // methods for its *stateful* mode. custos runs stateless-only, so both
  // are simply unsupported -- matching the SDK's own stateless example.
  app.get("/mcp", async (_req, reply) => {
    reply.code(405);
    return JSON_RPC_METHOD_NOT_ALLOWED;
  });
  app.delete("/mcp", async (_req, reply) => {
    reply.code(405);
    return JSON_RPC_METHOD_NOT_ALLOWED;
  });

  /**
   * Exposes groomBacklog/assignReady's narrow, per-run tool set at
   * POST /mcp/pm-run -- see mcp/pm-tools.ts for why this exists (replaces
   * asking a model to emit one big JSON block at the end of a run with
   * immediate, individually-validated tool calls). Gated by a per-run
   * token minted in orchestrator.ts right before dispatch, not the
   * process-lifetime internal key /mcp uses -- each token is scoped to
   * exactly one project and one run's ticket set, so a stale or
   * cross-project id a confused model tries to act on is rejected inside
   * the tool handler itself, not just by the token being valid at all.
   */
  app.post("/mcp/pm-run", async (req, reply) => {
    const auth = req.headers.authorization;
    const bearer = auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length) : undefined;
    const session = bearer ? lookupSession(bearer) : null;
    if (!session) {
      reply.code(401);
      return JSON_RPC_UNAUTHORIZED;
    }

    reply.hijack();
    const server =
      session.kind === "groom"
        ? buildGroomToolsServer(session)
        : session.kind === "assign"
          ? buildAssignToolsServer(session)
          : session.kind === "curate"
            ? buildCurateToolsServer(session)
            : session.kind === "qa"
              ? buildQaToolsServer(session)
              : buildEngineerToolsServer(session);
    try {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await server.connect(transport);
      await transport.handleRequest(req.raw, reply.raw, req.body);
      reply.raw.on("close", () => {
        void transport.close();
        void server.close();
      });
    } catch (err) {
      req.log.error({ err }, "PM-run MCP request failed");
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { "content-type": "application/json" });
        reply.raw.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null }));
      } else {
        reply.raw.end();
      }
    }
  });
  app.get("/mcp/pm-run", async (_req, reply) => {
    reply.code(405);
    return JSON_RPC_METHOD_NOT_ALLOWED;
  });
  app.delete("/mcp/pm-run", async (_req, reply) => {
    reply.code(405);
    return JSON_RPC_METHOD_NOT_ALLOWED;
  });
}
