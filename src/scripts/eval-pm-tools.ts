// One-off diagnostic: fires groomBacklog/assignReady's real prompt at a
// list of candidate Ollama models directly via /api/chat, with the same
// tool definitions pm-tools.ts registers for the real MCP server -- no
// running custos instance, no spawned claude CLI, no MCP round-trip, and
// critically no side effects on real board/agent data, since nothing here
// actually executes a tool call; it only inspects whether the model
// produced one.
//
// This tests the model's raw tool-calling behavior on the exact prompt
// content production would send, which is the load-bearing question
// (2026-08-11 investigation: qwen3.5:9b-q4_K_M kept failing to reliably
// call tools through three rounds of prompt tightening). It does NOT
// exercise Claude Code's own system-prompt scaffolding or its PreToolUse
// hook -- a model that can't tool-call here definitely won't through that
// heavier path either, but a model that CAN should still get a real
// end-to-end confirmation before switching production over to it.
//
// Usage (run against the real data dir, gateway stopped or running --
// this only reads):
//   node dist/scripts/eval-pm-tools.js <groom|assign> <projectName> <ollamaBaseUrl> <model1> [model2] ...
//
// Example:
//   node dist/scripts/eval-pm-tools.js assign lightspeed http://192.168.250.219:11434 hermes3:8b qwen2.5:14b-instruct-q4_K_M

import { listProjects } from "../remote/projects.js";
import * as board from "../pm/board.js";
import * as agentStore from "../pm/agents.js";
import { loadConfig } from "../config.js";
import { syncFromConfig } from "../pm/model-registry.js";
import { resolveProjectAgent, projectHeader, buildGroomPrompt, buildAssignPrompt } from "../pm/pm-prompts.js";
import { buildSystemPrompt } from "../pm/agent-runner.js";

const ABSOLUTE_MAX_ENGINEERS = 12; // mirrors orchestrator.ts's constant of the same name

interface OllamaTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
}

const GROOM_TOOLS: OllamaTool[] = [
  {
    type: "function",
    function: {
      name: "promote_ticket",
      description: "Moves a ticket from backlog to ready -- it will be picked up and worked autonomously. Only use this when the ticket is shaped well enough for an engineer to finish without coming back to ask what you meant.",
      parameters: {
        type: "object",
        properties: { ticketId: { type: "string", description: "The work item id, from the backlog list in your prompt." } },
        required: ["ticketId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "revise_ticket",
      description: "Updates a ticket's title, description, and/or acceptance criteria in place. Use this for a ticket that's nearly ready but needs tightening -- do not promote it in the same turn unless the revision alone makes it ready.",
      parameters: {
        type: "object",
        properties: {
          ticketId: { type: "string", description: "The work item id." },
          title: { type: "string", description: "New title, if it needs one." },
          description: { type: "string", description: "New description, if it needs one." },
          acceptanceCriteria: { type: "array", items: { type: "string" }, description: "Replacement acceptance criteria list, if it needs one." },
        },
        required: ["ticketId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "comment_on_ticket",
      description: "Leaves a comment explaining why a ticket is being held, or what decision it's still waiting on. Only comment when there's something new to say -- do not repeat an unchanged blocker you already noted on a previous pass.",
      parameters: {
        type: "object",
        properties: {
          ticketId: { type: "string", description: "The work item id." },
          body: { type: "string", description: "The comment text." },
        },
        required: ["ticketId", "body"],
      },
    },
  },
];

const ASSIGN_TOOLS: OllamaTool[] = [
  {
    type: "function",
    function: {
      name: "create_engineer",
      description: "Creates a new engineer agent on this project, to assign tickets to via assign_ticket. Returns the new agent's id.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Short human-readable name." },
          fallbackSet: { type: "string", description: "Exactly one of the fallback set names from the model menu in your prompt." },
          specialty: { type: "string", description: "One line: what this agent is for." },
          maxComplexity: { type: "string", enum: ["low", "medium", "high"], description: "The highest complexity ticket this agent should take." },
          systemPrompt: { type: "string", description: "Extra instructions appended to the standard engineer prompt." },
        },
        required: ["name", "fallbackSet", "maxComplexity"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "assign_ticket",
      description: "Sizes and assigns a ticket from the ready column to an engineer (existing or just created via create_engineer). Starts the engineer working immediately, in its own isolated checkout.",
      parameters: {
        type: "object",
        properties: {
          workItemId: { type: "string", description: "The ticket's id, from the ready column in your prompt." },
          agentId: { type: "string", description: "The engineer's id -- from your current roster, or returned by create_engineer this run." },
          complexity: { type: "string", enum: ["low", "medium", "high"], description: "Your sizing of this ticket." },
          rationale: { type: "string", description: "One line: why this agent, at this cost, for this ticket." },
        },
        required: ["workItemId", "agentId", "complexity"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "tune_engineer",
      description: "Appends a standing instruction and/or changes the fallback set or complexity ceiling for an existing engineer.",
      parameters: {
        type: "object",
        properties: {
          agentId: { type: "string", description: "The engineer's id." },
          note: { type: "string", description: "Instruction appended to that agent's prompt." },
          fallbackSet: { type: "string", description: "New fallback set, if it needs one." },
          maxComplexity: { type: "string", enum: ["low", "medium", "high"], description: "New complexity ceiling, if it needs one." },
        },
        required: ["agentId"],
      },
    },
  },
];

const RECORD_FACT: OllamaTool = {
  type: "function",
  function: {
    name: "record_fact",
    description: "Writes an entry to this project's shared knowledge store. Use only for something durable and cross-cutting -- not a note about one ticket.",
    parameters: {
      type: "object",
      properties: {
        key: { type: "string", description: 'Short stable key, e.g. "repo.url" or "test.command".' },
        value: { type: "string", description: "The fact's value." },
        category: { type: "string" },
      },
      required: ["key", "value"],
    },
  },
};

interface EvalResult {
  model: string;
  ok: boolean;
  durationMs: number;
  toolCalls: Array<{ name: string; arguments: unknown }>;
  content: string;
  error: string | null;
}

async function runOne(ollamaBaseUrl: string, model: string, systemPrompt: string, userPrompt: string, tools: OllamaTool[]): Promise<EvalResult> {
  const startedAt = Date.now();
  try {
    const res = await fetch(`${ollamaBaseUrl.replace(/\/$/, "")}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        tools,
        stream: false,
      }),
    });
    const durationMs = Date.now() - startedAt;
    if (!res.ok) {
      return { model, ok: false, durationMs, toolCalls: [], content: "", error: `HTTP ${res.status}: ${(await res.text()).slice(0, 300)}` };
    }
    const body = (await res.json()) as { message?: { content?: string; tool_calls?: Array<{ function: { name: string; arguments: unknown } }> } };
    const toolCalls = (body.message?.tool_calls ?? []).map((tc) => ({ name: tc.function.name, arguments: tc.function.arguments }));
    return { model, ok: true, durationMs, toolCalls, content: body.message?.content ?? "", error: null };
  } catch (err) {
    return { model, ok: false, durationMs: Date.now() - startedAt, toolCalls: [], content: "", error: (err as Error).message };
  }
}

async function main() {
  const [kind, projectName, ollamaBaseUrl, ...models] = process.argv.slice(2);
  if ((kind !== "groom" && kind !== "assign") || !projectName || !ollamaBaseUrl || !models.length) {
    console.error("usage: node dist/scripts/eval-pm-tools.js <groom|assign> <projectName> <ollamaBaseUrl> <model1> [model2] ...");
    process.exit(1);
  }

  const projects = await listProjects();
  const project = projects.find((p) => p.name === projectName);
  if (!project) {
    console.error(`no project named "${projectName}". Known projects: ${projects.map((p) => p.name).join(", ")}`);
    process.exit(1);
  }

  const role = kind === "groom" ? "product-owner" : "engineering-manager";
  const ctx = await resolveProjectAgent(project.id, role);
  if (!ctx) {
    console.error(`couldn't resolve ${role} agent for project "${projectName}"`);
    process.exit(1);
  }

  const header = await projectHeader(ctx.project, ctx.settings);
  let userPrompt: string;
  let tools: OllamaTool[];

  if (kind === "groom") {
    const backlog = (await board.listWorkItems(project.id)).filter((item) => item.status === "backlog");
    if (!backlog.length) {
      console.error("no backlog items to groom right now");
      process.exit(1);
    }
    userPrompt = buildGroomPrompt(header, backlog);
    tools = [...GROOM_TOOLS, RECORD_FACT];
  } else {
    const config = await loadConfig();
    const all = await board.listWorkItems(project.id);
    const ready = all.filter((item) => item.type !== "epic" && item.status === "ready");
    if (!ready.length) {
      console.error("no ready tickets to assign right now");
      process.exit(1);
    }
    const roster = await agentStore.listEngineers(project.id);
    const menu = agentStore.listProviderOptions(config);
    const modelRecords = await syncFromConfig(config, menu.filter((o) => o.providerKey === "anthropic").map((o) => o.model));
    const configured = Math.max(1, Math.min(ctx.settings.maxConcurrentEngineers ?? 1, ABSOLUTE_MAX_ENGINEERS));
    // isGitRepo needs a real filesystem check against the workspace; skip
    // it here (this script only reads board/agent data, not the repo) and
    // just use the configured ceiling directly -- close enough for a tool-
    // calling eval, since the exact limit number doesn't change whether a
    // model calls assign_ticket or not.
    const limit = configured;
    const inFlight = all.filter((item) => item.status === "in_progress").length;
    userPrompt = buildAssignPrompt(header, ready, roster, modelRecords, inFlight, limit);
    tools = [...ASSIGN_TOOLS, RECORD_FACT];
  }

  const systemPrompt = buildSystemPrompt(ctx.agent, undefined, undefined);

  console.log(`Prompt length: ${userPrompt.length} chars, system prompt: ${systemPrompt.length} chars`);
  console.log(`Testing ${models.length} model(s) against ${ollamaBaseUrl}\n`);

  const results: EvalResult[] = [];
  for (const model of models) {
    process.stdout.write(`=== ${model} ===\n`);
    const result = await runOne(ollamaBaseUrl, model, systemPrompt, userPrompt, tools);
    results.push(result);
    console.log(`  ok: ${result.ok} | duration: ${(result.durationMs / 1000).toFixed(1)}s | tool calls: ${result.toolCalls.length}`);
    for (const tc of result.toolCalls) console.log(`    - ${tc.name}(${JSON.stringify(tc.arguments)})`);
    if (result.content.trim()) console.log(`  content: ${result.content.trim().slice(0, 300)}${result.content.length > 300 ? "..." : ""}`);
    if (result.error) console.log(`  error: ${result.error}`);
    console.log();
  }

  console.log("=== summary ===");
  console.log("model,ok,durationSec,toolCalls,hasProse");
  for (const r of results) {
    console.log(`${r.model},${r.ok},${(r.durationMs / 1000).toFixed(1)},${r.toolCalls.length},${r.content.trim().length > 0}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
