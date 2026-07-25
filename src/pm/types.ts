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
  branch: string | null;
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

export type AgentRole = "steering" | "product-owner" | "engineering-manager" | "engineer" | "qa" | "devops";

export interface CostProfile {
  inputPerMTok: number;
  outputPerMTok: number;
  /** True for locally-hosted or free-tier models -- the EM strongly prefers
   * these for low-complexity work even when they're slower. */
  free: boolean;
  /** Null when unmetered. The EM avoids piling every ticket onto one
   * rate-limited provider. */
  requestsPerHour: number | null;
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
  role: AgentRole;
  name: string;
  /** Key into config.openaiCompatibleInstances, or "anthropic". */
  providerKey: string;
  model: string;
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
  costUsd: number | null;
  /** The agent's own final message, trimmed -- what shows in the activity
   * feed without having to replay the whole run. */
  summary: string;
  error: string | null;
}

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
  autonomy: Record<Exclude<AgentRole, "steering">, boolean>;
  /** Model alias the Steering Co tab runs on. Deliberately a high-end model
   * -- the whole point of that tab is a hard-to-fool sparring partner. */
  steeringModel: string;
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
    autonomy: { "product-owner": true, "engineering-manager": false, engineer: false, qa: false, devops: false },
    steeringModel: DEFAULT_STEERING_MODEL,
    updatedAt: Date.now(),
  };
}
