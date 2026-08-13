/** Output shapes, kept next to the prompts they belong to (role-prompts.ts)
 * so a change to one is visibly a change to the other. Each is fed through
 * outputContract() with the tag the orchestrator parses for. */
export const PLAN_SHAPE = `{
  "epics": [
    {
      "title": "string",
      "description": "markdown: the outcome, who it's for, what you found while researching, what's out of scope",
      "acceptanceCriteria": ["observable, verifiable statements about the epic as a whole"],
      "priority": 1,
      "stories": [
        {
          "type": "story" | "bug",
          "title": "string",
          "description": "markdown",
          "acceptanceCriteria": ["given/when/then or a checklist someone else could sign off"],
          "priority": 1
        }
      ]
    }
  ],
  "notes": "anything the humans should know, including why you left something out"
}`;

export const QA_SHAPE = `{
  "verdict": "pass" | "fail",
  "summary": "markdown: what you ran, what you checked, what you found",
  "criteriaChecked": [{ "criterion": "string", "result": "pass" | "fail", "evidence": "what you actually observed" }],
  "prComments": ["comments to post on the pull request"],
  "followUps": ["issues worth raising as separate bugs"]
}`;

export const SURVEY_SHAPE = `{
  "summary": "markdown: what this project is, what it's built with, and how it's laid out — written for an engineer who has never seen it",
  "notes": "anything surprising, risky, or likely to trip up someone changing this code"
}`;

export const PROVISION_SHAPE = `{
  "status": "provisioned" | "blocked",
  "summary": "markdown: what you created and how it's laid out",
  "repoUrl": "the clone URL of the repository, or null",
  "defaultBranch": "the branch name you initialised, or null",
  "blockedReason": "when status is blocked; otherwise null"
}`;

export const ASSIGN_MODELS_SHAPE = `{
  "assignments": [
    {
      "role": "product-owner" | "engineering-manager" | "engineer" | "qa" | "devops",
      "fallbackSet": "exactly one of the fallback set names from the menu",
      "rationale": "one line: why this fallback set for this role"
    }
  ],
  "notes": "any observations about provider availability, budget constraints, or risks the operator should know"
}`;

export const DEVOPS_SHAPE = `{
  "status": "deployed" | "blocked",
  "summary": "markdown: what you deployed, where, and how to roll it back",
  "awsRegion": "string -- required when deployTarget is aws, null otherwise",
  "resourcesCreated": [{ "kind": "string", "name": "string", "estimatedMonthlyUsd": 0 }],
  "estimatedMonthlyUsd": 0,
  "blockedReason": "when status is blocked -- including the cheapest alternative you can see; otherwise null"
}`;
