export interface CustosProject {
  id: string;
  name: string;
  workspaceDir: string;
  createdAt: number;
}

export type ChatKind = "chat" | "steering";

export interface CustosChat {
  id: string;
  projectId: string;
  title: string;
  kind: ChatKind;
  createdAt: number;
  endedAt: number | null;
  active: boolean;
  connectedClients: number;
  connectUrl: string | null;
}

export interface ApiResult<T = unknown> {
  ok: boolean;
  status: number;
  data: T;
  error?: string;
}

export interface AuthStatus {
  baseUrl: string | null;
  loggedIn: boolean;
}

export type MessageContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown };

/** Mirrors the backend turn-runner's TurnEvent union, plus the WS-level
 * "connected" frame the relay forwards. chatId is stamped on by the main
 * process so the renderer can route each event to the right tab. */
export type ChatEvent =
  | { type: "connected"; running: boolean }
  | { type: "session"; sessionId: string }
  | { type: "text_delta"; text: string }
  | { type: "message_final"; content: MessageContentBlock[] }
  | { type: "tool_result"; toolUseId: string; content: string; isError: boolean }
  | { type: "turn_complete"; resultText: string; isError: boolean; costUsd?: number }
  | { type: "approval_request"; id: string; toolName: string; toolInput: unknown; reason: string; severity: "ask" | "deny" }
  | { type: "approval_resolved"; id: string; decision: "allow" | "deny" }
  | { type: "idea_handoff"; ideaId: string; title: string }
  | { type: "error"; message: string };

export interface ChatEventEnvelope {
  chatId: string;
  event: ChatEvent;
}

export interface ChatClosedEvent {
  chatId: string;
  reason: string;
}

// ---------------------------------------------------------------- project management
// Mirrors the gateway's src/pm/types.ts. Kept as a hand-written copy rather
// than shared through a package: the two projects deploy separately, and the
// renderer only ever consumes these shapes over JSON.

export const BOARD_STATUSES = ["backlog", "ready", "in_progress", "qa", "complete"] as const;
export type BoardStatus = (typeof BOARD_STATUSES)[number];
export type WorkItemType = "epic" | "story" | "bug";
export type Complexity = "low" | "medium" | "high";
export type AgentRole = "steering" | "product-owner" | "engineering-manager" | "engineer" | "qa" | "devops";
export type DeployTarget = "none" | "docker-local" | "aws";

export interface Subtask {
  id: string;
  title: string;
  done: boolean;
}

export interface WorkItemComment {
  id: string;
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
  parentId: string | null;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  priority: number;
  complexity: Complexity | null;
  assigneeAgentId: string | null;
  subtasks: Subtask[];
  comments: WorkItemComment[];
  labels: string[];
  prUrl: string | null;
  branch: string | null;
  worktreePath: string | null;
  attempts: number;
  nextAttemptAt: number | null;
  qaRounds: number;
  sourceIdeaId: string | null;
  createdAt: number;
  updatedAt: number;
  history: HistoryEntry[];
}

export interface Idea {
  id: string;
  projectId: string;
  title: string;
  brief: string;
  sourceChatId: string | null;
  status: "inbox" | "planning" | "planned" | "rejected";
  epicIds: string[];
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface EpicWithChildren {
  epic: WorkItem;
  children: WorkItem[];
  progress: number;
}

export interface AgentStats {
  assigned: number;
  completed: number;
  qaRejections: number;
  totalCostUsd: number;
  avgRunMs: number;
}

export interface AgentDef {
  id: string;
  projectId: string | null;
  role: AgentRole;
  name: string;
  providerKey: string;
  model: string;
  systemPrompt: string;
  specialty: string | null;
  createdBy: "system" | "engineering-manager" | "human";
  maxComplexity: Complexity;
  stats: AgentStats;
  active: boolean;
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
  providerKey: string;
  model: string;
  billed: boolean;
  costUsd: number | null;
  summary: string;
  error: string | null;
  /** When this run last produced any event — how a stuck agent is spotted. */
  lastEventAt: number;
  /** One line describing what it is doing right now. */
  currentAction: string | null;
  toolCalls: number;
}

export type FactCategory = "repo" | "environment" | "convention" | "docs" | "decision" | "contact";

/** An entry in the project's shared knowledge store, readable by every
 * agent — how DevOps tells the engineers where the repository is. */
export interface ProjectFact {
  id: string;
  projectId: string;
  key: string;
  value: string;
  category: FactCategory;
  writtenBy: string;
  writtenByLabel: string;
  createdAt: number;
  updatedAt: number;
}

export interface ProviderOption {
  providerKey: string;
  model: string;
  free: boolean;
  inputPerMTok: number | null;
  outputPerMTok: number | null;
  budgetUsd: number | null;
}

export interface ProjectSettings {
  id: string;
  repoUrl: string | null;
  defaultBranch: string;
  docsPaths: string[];
  deployTarget: DeployTarget;
  deployConfig: Record<string, string>;
  budget: { monthlyUsd: number | null; infraMonthlyUsd: number | null };
  autonomy: Record<Exclude<AgentRole, "steering">, boolean>;
  maxConcurrentEngineers: number;
  steeringModel: string;
  updatedAt: number;
}

export interface RoadmapResponse {
  inbox: Idea[];
  planned: Idea[];
  epics: EpicWithChildren[];
  busy: string[];
}

export interface BoardResponse {
  columns: Record<BoardStatus, WorkItem[]>;
  epics: WorkItem[];
  agents: AgentDef[];
  busy: string[];
}

export interface ActivityResponse {
  runs: AgentRun[];
  active: AgentRun[];
  /** Runs that have produced no events for a while — surfaced, not killed. */
  stalledRunIds: string[];
  busy: string[];
}

/** Vault entry as the API exposes it. The value is deliberately absent:
 * there is no endpoint that returns a stored secret, only its metadata and
 * the last four characters. */
export interface SecretSummary {
  id: string;
  name: string;
  description: string;
  projectId: string | null;
  exposeToAgents: boolean;
  useForGit: boolean;
  hint: string;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
}

/** Notification-only: the client refetches whatever tab it's showing. */
export type PmEvent =
  | { type: "connected"; projectId: string }
  | { type: "pm_change"; projectId: string }
  | { type: "pm_activity"; projectId: string; message: string; at: number };
