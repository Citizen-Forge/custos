/** The five board columns every story and bug moves through. Epics use the
 * same enum but in practice only sit in backlog/ready/in_progress/complete
 * -- they're rolled up from their children rather than worked directly. */
export const BOARD_STATUSES = ["backlog", "ready", "in_progress", "qa", "complete"] as const;
export type BoardStatus = (typeof BOARD_STATUSES)[number];

export type WorkItemType = "epic" | "story" | "bug";

export type Complexity = "low" | "medium" | "high";

export interface Subtask {
  id: string;
  title: string;
  done: boolean;
}

export interface Comment {
  id: string;
  /** Agent id, or "human" when it came from the desktop app. */
  author: string;
  authorLabel: string;
  body: string;
  createdAt: number;
}

export interface HistoryEntry {
  at: number;
  actor: string;
  from: BoardStatus | null;
  to: BoardStatus;
  note?: string;
}

export interface WorkItem {
  id: string;
  projectId: string;
  type: WorkItemType;
  status: BoardStatus;
  /** Stories and bugs hang off an epic; epics have null. Bugs may also be
   * parentless when they're raised against the product rather than a
   * specific epic's work. */
  parentId: string | null;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  /** Sort key within a column -- lower floats to the top. The product owner
   * sets it on epics/stories; humans reorder by drag in the board UI. */
  priority: number;
  /** Set by the engineering manager when it sizes the ticket; drives which
   * agent (and therefore which model tier) can be assigned. */
  complexity: Complexity | null;
  assigneeAgentId: string | null;
  subtasks: Subtask[];
  comments: Comment[];
  labels: string[];
  prUrl: string | null;
  prComments: { text: string; createdAt: number }[];
  branch: string | null;
  /** The isolated git worktree this ticket is being worked in, so several
   * engineers can run at once without sharing a working copy. Null before
   * the first engineer run, and again once the ticket is released. */
  worktreePath: string | null;
  /** Consecutive failed agent runs against this ticket. Drives the retry
   * backoff -- a ticket pinned to a rate-limited provider would otherwise
   * be re-dispatched on every tick and never get anywhere. */
  attempts: number;
  /** Earliest time the orchestrator may dispatch this ticket again. */
  nextAttemptAt: number | null;
  /** How many times QA has bounced this back to in_progress. The EM reads
   * it as the primary quality signal when tuning an engineer agent. */
  qaRounds: number;
  /** For epics: the steering-co idea that produced them. */
  sourceIdeaId: string | null;
  createdAt: number;
  updatedAt: number;
  history: HistoryEntry[];
}

/** A brief handed off from the Steering Co tab. Lands in the roadmap inbox,
 * where the product owner agent picks it up and breaks it into epics. */
export interface Idea {
  id: string;
  projectId: string;
  title: string;
  /** The distilled brief the steering agent produced at handoff -- problem,
   * proposed shape, constraints, open questions. Not the raw transcript. */
  brief: string;
  /** The steering chat it came out of, so the PO agent (and a human) can go
   * back and read the full argument if the brief is ambiguous. */
  sourceChatId: string | null;
  status: "inbox" | "planning" | "planned" | "rejected";
  /** Epics the product owner created from it. */
  epicIds: string[];
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

export type AgentRole = "steering" | "product-owner" | "engineering-manager" | "engineer" | "qa" | "devops" | "project-manager";

/** Built-in service the gateway runs project-orthogonally: memory
 * curation, permission classification, embeddings, future global hooks.
 * Each is a global agent — same storage, same shape as project agents —
 * keyed by `systemRole`. The orchestrator doesn't assign tickets to them;
 * the runtime calls them directly when the relevant hook fires. */
export type GlobalSystemRole = "memoryCurator" | "permissionClassifier" | "embeddings";

export interface CostProfile {
  inputPerMTok: number;
  outputPerMTok: number;
  /** True for locally-hosted or free-tier models -- the EM strongly prefers
   * these for low-complexity work even when they're slower. */
  free: boolean;
}

export interface AgentStats {
  assigned: number;
  completed: number;
  qaRejections: number;
  totalCostUsd: number;
  /** Rolling mean of wall-clock run time, for the EM's time-vs-cost call. */
  avgRunMs: number;
}

export interface AgentDef {
  id: string;
  /** Null for the built-in roles that are shared across every project. */
  projectId: string | null;
  /** "project" agents participate in board assignment; "global" agents run
   *  project-orthogonal services (memory curator, permission classifier,
   *  embeddings) keyed by `systemRole`. Defaults to "project" via the
   *  on-read backfill in pm/agents.ts so records written before the
   *  project-orthogonal split don't need a migration. */
  kind: "project" | "global";
  /** Built-in service this global agent runs. Undefined for project agents.
   *  The orchestrator does not assign tickets to global agents — only the
   *  runtime that owns the service does, and it looks the agent up by
   *  `systemRole`. */
  systemRole?: GlobalSystemRole;
  /** Embeddings endpoint base URL, only meaningful when
   *  `systemRole === "embeddings"`. The Ollama convention strips the
   *  OpenAI-compat `/v1` from the chat provider's `baseUrl` and exposes
   *  embeddings at `/api/embeddings`; OpenAI-compat providers keep the
   *  `/v1` and POST to `/embeddings`. When unset the runtime derives the
   *  URL from the named providerKey. Set this to override when pointing a
   *  custom Ollama host or a non-conventional server at the embeddings
   *  global agent. */
  embeddingBaseUrl?: string;
  role: AgentRole;
  /** The role-descriptive name, e.g. "Simulation Architect". */
  name: string;
  /** A human name, so a board full of agents is legible at a glance. Null
   * on records created before personas existed. */
  personaName: string | null;
  /** Name of the fallback set this agent uses for dispatch (see
   *  GatewayConfig.fallbackSets). The runtime resolves it to the first
   *  available provider in the set; if that provider 429s mid-run the
   *  next request in the same subprocess falls through to the next
   *  entry in the set. The PM assigns fallback sets to every role. The
   *  "primary pick" -- what the operator sees on the badge -- is just
   *  fallbackSet[0], derived at read-time via primaryPick(agent, config)
   *  rather than stored on every agent record; this prevents drift
   *  between the operator-facing hint and the dispatch target when
   *  config changes. */
  fallbackSet?: string;
  /** Appended to the role's base prompt rather than replacing it, so an EM
   * tuning an engineer can't accidentally delete its board contract. */
  systemPrompt: string;
  /** Free text the EM writes when it creates a specialist, e.g. "React/TS
   * frontend work, strong on CSS". Shown in the assignment prompt. */
  specialty: string | null;
  createdBy: "system" | "engineering-manager" | "human";
  maxComplexity: Complexity;
  costProfile: CostProfile | null;
  stats: AgentStats;
  active: boolean;
  /** Refinements the EM has appended over time from its feedback loop --
   * kept as a list so the history of "why this agent is worded this way" is
   * visible instead of being overwritten each tuning pass. */
  notes: string[];
  createdAt: number;
  updatedAt: number;
}

export interface AgentRun {
  id: string;
  projectId: string;
  agentId: string;
  role: AgentRole;
  workItemId: string | null;
  ideaId: string | null;
  status: "running" | "succeeded" | "failed";
  startedAt: number;
  endedAt: number | null;
  claudeSessionId: string | null;
  /** Where this run was pinned, so the activity feed can show it and the
   * budget can tell metered spend from subscription usage. */
  providerKey: string;
  model: string;
  /** Whether costUsd draws down the project's budget. Claude Code reports a
   * total_cost_usd for every run, including ones served by the Anthropic
   * subscription or a local model, where nothing is actually charged --
   * counting those would pause a project against money it never spent. */
  billed: boolean;
  costUsd: number | null;
  /** The agent's own final message, trimmed -- what shows in the activity
   * feed without having to replay the whole run. */
  summary: string;
  error: string | null;
  /** When this run last produced any event at all. A stuck agent is
   * detected from this rather than from anything it says about itself:
   * the agent least able to report that it's stuck is a stuck one. */
  lastEventAt: number;
  /** One line describing what it is doing right now, derived from its most
   * recent tool call ("Bash: npm test", "Edit: src/index.ts"). */
  currentAction: string | null;
  /** Rolling count of tool calls, as a cheap progress signal. */
  toolCalls: number;
  /** QA's verdict on this run's output, attached by runQa after the
   * contract is parsed. Populated on the ENGINEER's run row (not the
   * QA agent's) because the engineer is the agent whose card needs the
   * surface context for its rejection rate -- "Last QA bounce: <reason>"
   * rides on the same agent stats row that shows `qaRejections`. Criterion
   * and evidence are truncated on write so a chatty QA verdict can't
   * inflate the run file. Required when present: `verdict`; `criterion`
   * and `evidence` are the picked-decisive ones and may be absent. */
  qaBounce?: {
    verdict: "pass" | "fail";
    criterion?: string;
    evidence?: string;
  };
}

/** Sentinel `assigneeAgentId` for a ticket a human claimed directly (via the
 * MCP claim_ticket tool) instead of an engineer agent. Deliberately not a
 * real row in agents.json -- every downstream reader of `assigneeAgentId`
 * already null-checks `agentStore.getAgent()`'s result (QA capability
 * feedback, run-result recording, the board UI's agent lookup), so this
 * sentinel is safe wherever it's read. The one place that isn't automatic:
 * the tick loop's engineer-dispatch filter, which must skip tickets
 * assigned to this sentinel explicitly (see orchestrator.ts) or it would
 * retry `runEngineer` against a nonexistent agent every tick forever. */
export const HUMAN_ASSIGNEE_ID = "human";

/** How long a run may produce no events before it's considered stalled.
 * Long enough to cover a slow model thinking or a long test suite, short
 * enough that a genuinely hung run is visible within a coffee break. */
export const STALL_THRESHOLD_MS = 6 * 60_000;

/** Hard wall-clock ceiling on a single agent run. Past this it's aborted:
 * whatever it's doing, it isn't converging, and it's spending money.
 *
 * Raised from 45 to 90 minutes: with `local` sitting first in the
 * `complex` fallback set and a single concurrency slot, a Task
 * sub-agent's own request can land 8+ deep in `local`'s queue behind
 * other work -- observed live taking the full 45 minutes just to clear
 * that queue depth before the sub-agent's own dispatch even starts,
 * with the parent run blocked on it the whole time and toolCalls stuck
 * at 0. That's real (if slow) progress being cut off at the wire, not a
 * hung run -- see the "This operation was aborted" investigation in the
 * routes.ts SSE early-commit fix for the related client-timeout half of
 * this same debugging session. */
export const RUN_TIMEOUT_MS = Number(process.env.CUSTOS_RUN_TIMEOUT_MS ?? 90 * 60_000);

export type DeployTarget = "none" | "docker-local" | "aws";

export interface ProjectSettings {
  /** Same value as the project id -- ProjectSettings is a 1:1 sidecar. */
  id: string;
  repoUrl: string | null;
  defaultBranch: string;
  /** Extra context files (specs, ADRs) the steering and PO agents read
   * before answering, relative to the workspace dir. */
  docsPaths: string[];
  deployTarget: DeployTarget;
  /** Free-form per-target settings (AWS region/profile, compose file path). */
  deployConfig: Record<string, string>;
  budget: {
    /** Hard ceiling on agent spend per calendar month; null = unlimited. */
    monthlyUsd: number | null;
    /** Separate ceiling for infrastructure the devops agent provisions, so
     * a runaway deployment can't eat the whole agent budget. */
    infraMonthlyUsd: number | null;
  };
  /** Which loops the orchestrator runs unattended. Everything defaults off
   * except the product owner -- autonomous engineering that spends money
   * and pushes branches is opt-in per project, not on by default. */
  /** The killswitch. When true nothing is dispatched and anything running
   * is aborted -- a single flag that doesn't require touching five autonomy
   * toggles to stop the project, and that survives a restart so it can't
   * quietly resume while nobody is looking. */
  paused: boolean;
  autonomy: Record<Exclude<AgentRole, "steering">, boolean>;
  /** Ceiling on engineers working this project at once. Each one gets its
   * own git worktree, so this is a spend-and-load limit rather than a
   * correctness one -- the engineering manager decides the actual fan-out
   * beneath it, and is told what the ceiling is. Projects that aren't git
   * repositories are clamped to 1 regardless, since there's nothing to
   * isolate the working copies with. */
  maxConcurrentEngineers: number;
  /** Model alias the Steering Co tab runs on. Deliberately a high-end model
   * -- the whole point of that tab is a hard-to-fool sparring partner. */
  steeringModel: string;
  /** Whether the Project Manager agent has run at least once to assign
   * provider/models to the built-in roles. Until this is true the
   * orchestrator runs the PM on every tick (once per project) to seed
   * the roster with budget-aware model choices. */
  pmConfigured: boolean;
  /** When the Project Manager last completed an assignment pass. Null when
   * the PM has never run. Rendered in the project card so operators can see
   * whether a recent provider or budget edit needs a manual reassignment. */
  pmLastRunAt: number | null;
  /** Slack channel ID this project's agent activity posts to and picks
   *  up dropped ideas from (see slack.ts). Null means this project has
   *  no Slack channel wired up -- distinct from the global slack.enabled
   *  killswitch, which turns the whole integration off regardless of
   *  which projects have a channel configured. */
  slackChannelId: string | null;
  updatedAt: number;
}

export const DEFAULT_STEERING_MODEL = "custos:anthropic/claude-opus-5";

export function defaultProjectSettings(projectId: string): ProjectSettings {
  return {
    id: projectId,
    repoUrl: null,
    defaultBranch: "main",
    docsPaths: [],
    deployTarget: "none",
    deployConfig: {},
    budget: { monthlyUsd: null, infraMonthlyUsd: null },
    paused: false,
    pmConfigured: false,
    pmLastRunAt: null,
    slackChannelId: null,
    autonomy: { "product-owner": true, "engineering-manager": false, engineer: false, qa: false, devops: false, "project-manager": true },
    maxConcurrentEngineers: 3,
    steeringModel: DEFAULT_STEERING_MODEL,
    updatedAt: Date.now(),
  };
}
