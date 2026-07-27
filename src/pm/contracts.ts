import type { FactCategory } from "./facts.js";
import type { Complexity, WorkItemType } from "./types.js";

/** Any role may contribute to the project's shared knowledge store on the
 * way out of a run -- see pm/facts.ts. Optional everywhere: most runs learn
 * nothing worth keeping, and inventing a fact to fill a field is worse than
 * leaving it empty. */
export interface FactWrite {
  key?: string;
  value?: string;
  category?: FactCategory;
}

interface WithFacts {
  facts?: FactWrite[];
}

/** The JSON each role returns in its fenced contract block. These mirror
 * the shapes documented in prompts.ts; every field is optional at the type
 * level because they arrive from a language model and the orchestrator is
 * responsible for tolerating a partially-filled block rather than trusting
 * the schema. */

export interface PlanStory {
  type?: WorkItemType;
  title?: string;
  description?: string;
  acceptanceCriteria?: string[];
  priority?: number;
}

export interface PlanEpic {
  title?: string;
  description?: string;
  acceptanceCriteria?: string[];
  priority?: number;
  stories?: PlanStory[];
}

export interface PlanContract extends WithFacts {
  epics?: PlanEpic[];
  notes?: string;
}

export interface GroomContract extends WithFacts {
  promote?: string[];
  revise?: Array<{ id?: string; title?: string; description?: string; acceptanceCriteria?: string[] }>;
  comments?: Array<{ id?: string; body?: string }>;
  notes?: string;
}

export interface AssignContract extends WithFacts {
  newAgents?: Array<{
    tempId?: string;
    name?: string;
    providerKey?: string;
    model?: string;
    specialty?: string;
    maxComplexity?: Complexity;
    systemPrompt?: string;
  }>;
  assignments?: Array<{ workItemId?: string; complexity?: Complexity; agentId?: string; tempId?: string; rationale?: string }>;
  tuning?: Array<{ agentId?: string; note?: string; providerKey?: string; model?: string; maxComplexity?: Complexity }>;
  notes?: string;
}

export interface EngineerContract extends WithFacts {
  status?: "ready_for_qa" | "blocked";
  summary?: string;
  subtasks?: Array<{ title?: string; done?: boolean }>;
  branch?: string | null;
  prUrl?: string | null;
  blockedReason?: string | null;
  followUps?: string[];
}

export interface QaContract extends WithFacts {
  verdict?: "pass" | "fail";
  summary?: string;
  criteriaChecked?: Array<{ criterion?: string; result?: "pass" | "fail"; evidence?: string }>;
  prComments?: string[];
  followUps?: string[];
}

export interface ProvisionContract extends WithFacts {
  status?: "provisioned" | "blocked";
  summary?: string;
  repoUrl?: string | null;
  defaultBranch?: string | null;
  blockedReason?: string | null;
}

export interface DevopsContract extends WithFacts {
  status?: "deployed" | "blocked";
  summary?: string;
  resourcesCreated?: Array<{ kind?: string; name?: string; estimatedMonthlyUsd?: number }>;
  estimatedMonthlyUsd?: number;
  blockedReason?: string | null;
}

export interface ProjectManagerContract extends WithFacts {
  assignments?: Array<{
    role: "product-owner" | "engineering-manager" | "engineer" | "qa" | "devops";
    providerKey: string;
    model: string;
    rationale?: string;
  }>;
  notes?: string;
}

/** Emitted by the steering chat when the user hands an idea off. Parsed out
 * of ordinary assistant text rather than a contract run, since steering is
 * an interactive chat and not an orchestrated agent. */
export interface HandoffContract {
  title?: string;
  brief?: string;
}
