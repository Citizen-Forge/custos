// DevOps stages: standing up a new project's repository, and the merge +
// deploy pipeline for tickets that have cleared QA.
import * as board from "../board.js";
import * as agentStore from "../agents.js";
import { runAgent } from "../agent-runner.js";
import { resolveProjectAgent, projectHeader } from "../pm-prompts.js";
import { renderWorkItem } from "../context.js";
import { checkPrReadyToMerge, mergePullRequest } from "../worktrees.js";
import { hasGitCredentials, resolveAgentEnv } from "../vault.js";
import { DEVOPS_SHAPE, PROVISION_SHAPE, outputContract } from "../prompts.js";
import type { DevopsContract, ProvisionContract } from "../contracts.js";
import type { DeployTarget } from "../types.js";
import { updateSettings } from "../project-settings.js";
import { applyFacts, handleDispatchFailure } from "./shared.js";
import type { Orchestrator } from "../orchestrator.js";

/** Applied to work that reaches "complete" and hasn't been deployed yet.
 * A label rather than a status so the board's five columns stay the ones
 * the user asked for. */
export const DEPLOYED_LABEL = "deployed";

/**
 * Creates the project's repository. Nothing downstream works without one:
 * engineers have nowhere to branch, QA has nothing to check out, and a
 * repository with no commits can't be split into worktrees, so the whole
 * board would run single-file in a shared directory.
 */
export async function provisionRepo(orch: Orchestrator, projectId: string): Promise<void> {
  await orch.guard(`provision:${projectId}`, projectId, async (signal) => {
    const ctx = await resolveProjectAgent(projectId, "devops");
    if (!ctx) return;
    if (ctx.settings.repoUrl) return; // already stood up
    const va = { personaName: ctx.agent.personaName, name: ctx.agent.name, role: ctx.agent.role };

    if (!(await hasGitCredentials(projectId))) {
      orch.emit("activity", projectId, {
        text: "Can't create a repository: no git credentials in the vault. Add a GitHub token in DevOps and mark it 'use for git'.",
        slackText: "I can't create a repository: no git credentials in the vault. Add a GitHub token in DevOps and mark it 'use for git'.",
        agent: va,
      });
      return;
    }

    const prompt = [
      await projectHeader(ctx.project, ctx.settings),
      "",
      "## Your task",
      "",
      `Stand up the repository for this project. Its working copy is \`${ctx.project.workspaceDir}\` — create the remote, initialise it there with a single honest first commit, push, and record where it lives in the shared facts store.`,
      "",
      "Do not scaffold an application. The roadmap decides what gets built; you are only making somewhere for it to go.",
    ].join("\n");

    const result = await runAgent<ProvisionContract>(orch.runtime, {
      signal,
      agent: ctx.agent,
      projectId,
      cwd: ctx.project.workspaceDir,
      prompt,
      tag: "custos-provision",
      outputContract: outputContract("custos-provision", PROVISION_SHAPE),
    });

    await applyFacts(projectId, ctx.agent, result.parsed);

    if (!result.ok || result.parsed?.status !== "provisioned" || !result.parsed.repoUrl) {
      // No provider available isn't worth an activity line -- nothing
      // was attempted, and the next tick retries for free (see
      // handleDispatchFailure's doc comment for the full reasoning).
      if (result.unavailable) return;
      const reason = result.parsed?.blockedReason ?? result.error ?? "no repository URL returned";
      orch.emit("activity", projectId, {
        text: `Repository provisioning failed: ${reason}`,
        slackText: `Repository provisioning failed: ${reason}`,
        agent: va,
      });
      return;
    }

    await updateSettings(projectId, {
      repoUrl: result.parsed.repoUrl,
      ...(result.parsed.defaultBranch ? { defaultBranch: result.parsed.defaultBranch } : {}),
    });
    orch.emit("activity", projectId, {
      text: `DevOps created the repository: ${result.parsed.repoUrl}`,
      slackText: `I created the repository: ${result.parsed.repoUrl}`,
      agent: va,
    });
  });
}

export async function runDevops(orch: Orchestrator, projectId: string, workItemId: string): Promise<void> {
  await orch.guard(`devops:${workItemId}`, projectId, async (signal) => {
    const item = await board.getWorkItem(workItemId);
    if (!item || item.labels.includes(DEPLOYED_LABEL)) return;
    const ctx = await resolveProjectAgent(projectId, "devops");
    if (!ctx) return;
    const va = { personaName: ctx.agent.personaName, name: ctx.agent.name, role: ctx.agent.role };

    // -------------------------------------------------------------
    // Deterministic merge gate. No LLM involved: "does the PR have a
    // QA-approved comment" and "is it mergeable" are both plain API
    // reads with an exact yes/no answer. Running a full agent turn to
    // re-derive them on every retry was the direct cause of a real
    // context/cost blowup -- a blocked ticket got redispatched every
    // tick, and each dispatch re-read an ever-growing comment history
    // just to re-ask an LLM the same question. See worktrees.ts's
    // checkPrReadyToMerge for the detailed reasoning.
    if (!item.prUrl) {
      const backedOff = await board.recordAttemptFailure(workItemId);
      orch.emit("activity", projectId, {
        text: `DevOps can't merge "${item.title}" (attempt ${backedOff?.attempts ?? 1}): the ticket has no prUrl recorded.`,
        slackText: `I can't merge "${item.title}" (attempt ${backedOff?.attempts ?? 1}): the ticket has no prUrl recorded.`,
        agent: va,
      });
      return;
    }
    const gitEnv = await resolveAgentEnv(projectId);
    const gate = await checkPrReadyToMerge(ctx.project.workspaceDir, item.prUrl, gitEnv);
    if (!gate.ready) {
      // "unmergeable" is categorically different from the other block
      // kinds (waiting on QA, GitHub still computing mergeability, a
      // transient read error): those resolve on their own with time,
      // so re-checking on backoff is the right move. A real conflict
      // never will -- the gate only reads GitHub state, it doesn't
      // write code -- so leaving it in `complete` to be re-checked
      // forever just means it sits stuck with nothing able to fix it.
      // Bounce it back to in_progress instead so the engineer dispatch
      // loop picks it up again; worktreePath/branch/prUrl are left
      // untouched (transitionWorkItem doesn't touch them) so the
      // engineer resumes the same checkout and force-pushes the same
      // PR, exactly like the existing QA-bounce-back path already
      // tells it to.
      if (gate.kind === "unmergeable") {
        await board.transitionWorkItem(workItemId, "in_progress", ctx.agent.id, gate.reason);
        await board.addComment(workItemId, "system", "DevOps gate", `Sent back to engineering: ${gate.reason}`);
        orch.emit("activity", projectId, {
          text: `DevOps sent "${item.title}" back to in_progress: ${gate.reason}`,
          slackText: `I sent "${item.title}" back to in_progress: ${gate.reason}`,
          agent: va,
        });
        return;
      }
      const backedOff = await board.recordAttemptFailure(workItemId);
      // Same reasoning as the missing-PR gate on the engineer path:
      // worth surfacing once so an operator can see why a ticket is
      // stuck, but re-posting the identical reason on every retry is
      // exactly what compounds the ticket's comment history -- and
      // thus every future agent dispatch's prompt size -- without
      // adding new information.
      if ((backedOff?.attempts ?? 1) === 1) {
        await board.addComment(workItemId, "system", "DevOps gate", `Not merged yet: ${gate.reason}`);
      }
      orch.emit("activity", projectId, {
        text: `DevOps gate held "${item.title}" (attempt ${backedOff?.attempts ?? 1}): ${gate.reason}`,
        slackText: `I'm holding "${item.title}" (attempt ${backedOff?.attempts ?? 1}): ${gate.reason}`,
        agent: va,
      });
      return;
    }
    const merged = await mergePullRequest(ctx.project.workspaceDir, item.prUrl, gitEnv);
    if (!merged.ok) {
      // The gate passed a moment ago but the merge itself failed --
      // a genuine race (someone pushed a conflicting change in
      // between) rather than a re-derivable fact, so this one is
      // worth a comment every time it recurs, not just once.
      const backedOff = await board.recordAttemptFailure(workItemId);
      await board.addComment(workItemId, "system", "DevOps gate", `Merge attempt failed: ${merged.reason}`);
      orch.emit("activity", projectId, {
        text: `DevOps failed to merge "${item.title}" (attempt ${backedOff?.attempts ?? 1}): ${merged.reason}`,
        slackText: `I failed to merge "${item.title}" (attempt ${backedOff?.attempts ?? 1}): ${merged.reason}`,
        agent: va,
      });
      return;
    }
    await board.addComment(workItemId, "system", "DevOps gate", `Merged pull request ${item.prUrl}.`);

    if (ctx.settings.deployTarget === "none") {
      // Merging was the whole job for a project with nothing to
      // deploy -- no agent dispatch needed at all.
      await board.clearAttempts(workItemId);
      await board.updateWorkItem(workItemId, { labels: [...item.labels, DEPLOYED_LABEL] });
      orch.emit("activity", projectId, {
        text: `DevOps merged the pull request for "${item.title}".`,
        slackText: `I merged the pull request for "${item.title}".`,
        agent: va,
      });
      return;
    }

    // -------------------------------------------------------------
    // Past this point the PR is merged and there's an actual
    // deployment target -- this is the part that genuinely needs
    // agent judgement (infra choices, budget estimation, rollback
    // planning), so it's the only part still dispatched as an agent.
    const prompt = [
      await projectHeader(ctx.project, ctx.settings),
      "",
      `## Deployment target: ${ctx.settings.deployTarget}`,
      "",
      deploymentTargetSection(ctx.settings.deployTarget, ctx.settings.deployConfig),
      "",
      Object.entries(ctx.settings.deployConfig).map(([key, value]) => `- ${key}: ${value}`).join("\n") || "_No target-specific settings configured._",
      "",
      ctx.settings.budget.infraMonthlyUsd !== null
        ? `## Infrastructure budget\n\n$${ctx.settings.budget.infraMonthlyUsd.toFixed(2)} per month, hard limit.`
        : "## Infrastructure budget\n\nNo cap is configured, but keep costs proportionate and report your estimate anyway.",
      "",
      "## The work to deploy (already merged)",
      "",
      renderWorkItem(item, { includeComments: true }),
    ].join("\n");

    const result = await runAgent<DevopsContract>(orch.runtime, {
      signal,
      agent: ctx.agent,
      projectId,
      cwd: ctx.project.workspaceDir,
      prompt,
      tag: "custos-devops",
      outputContract: outputContract("custos-devops", DEVOPS_SHAPE),
      workItemId,
    });

    await applyFacts(projectId, ctx.agent, result.parsed);
    if (!result.ok || !result.parsed) {
      // Not persisted as a board comment -- see the identical note on
      // the QA path above.
      const attempt = await handleDispatchFailure(workItemId, result.unavailable);
      if (attempt === null) return;
      const reason = result.error ?? "unknown error";
      orch.emit("activity", projectId, {
        text: `${ctx.agent.name} deployment run failed on "${item.title}" (attempt ${attempt}): ${reason}; will retry.`,
        slackText: `My deployment run failed on "${item.title}" (attempt ${attempt}): ${reason}. I'll retry.`,
        agent: va,
      });
      return;
    }

    const contract = result.parsed;
    // AWS deployments must report the region the resources actually landed
    // in -- the devops gate, not a prompt nicety. The orchestrator is the
    // only place that can enforce this because the LLM-side `awsRegion`
    // field is loose by design.
    if (ctx.settings.deployTarget === "aws" && (!contract.awsRegion || contract.awsRegion.trim() === "")) {
      const backedOff = await board.recordAttemptFailure(workItemId);
      if ((backedOff?.attempts ?? 1) === 1) {
        await board.addComment(workItemId, ctx.agent.id, agentStore.displayName(ctx.agent), `DevOps deployment missing awsRegion: required when deployTarget is aws.`);
      }
      orch.emit("activity", projectId, {
        text: `DevOps deployment missing awsRegion on "${item.title}" (attempt ${backedOff?.attempts ?? 1}). Use the project's deployConfig.awsRegion or report it in the contract.`,
        slackText: `My deployment is missing awsRegion on "${item.title}" (attempt ${backedOff?.attempts ?? 1}). I need the project's deployConfig.awsRegion set, or I need to report it in the contract.`,
        agent: va,
      });
      return;
    }
    if (contract.status !== "deployed") {
      const backedOff = await board.recordAttemptFailure(workItemId);
      if ((backedOff?.attempts ?? 1) === 1 && (contract.summary ?? "").trim()) {
        await board.addComment(workItemId, ctx.agent.id, agentStore.displayName(ctx.agent), contract.summary ?? "");
      }
      orch.emit("activity", projectId, {
        text: `DevOps is blocked on "${item.title}" (attempt ${backedOff?.attempts ?? 1}): ${contract.blockedReason ?? "no reason given"}`,
        slackText: `I'm blocked on "${item.title}" (attempt ${backedOff?.attempts ?? 1}): ${contract.blockedReason ?? "no reason given"}`,
        agent: va,
      });
      return;
    }
    await board.clearAttempts(workItemId);
    if ((contract.summary ?? "").trim()) {
      await board.addComment(workItemId, ctx.agent.id, agentStore.displayName(ctx.agent), contract.summary ?? "");
    }
    await board.updateWorkItem(workItemId, { labels: [...item.labels, DEPLOYED_LABEL] });
    const costNote = contract.estimatedMonthlyUsd ? ` (~$${contract.estimatedMonthlyUsd}/mo)` : "";
    const regionNote = contract.awsRegion ? ` in ${contract.awsRegion}` : "";
    orch.emit("activity", projectId, {
      text: `DevOps deployed "${item.title}"${costNote}${regionNote}.`,
      slackText: `I deployed "${item.title}"${costNote}${regionNote}.`,
      agent: va,
    });
  });
}

/** Per-target guidance injected into the devops agent's prompt. The audit
 * at docs/union-audit.md treats this as the runtime fork that proves
 * `DeployTarget.docker-local` and `DeployTarget.aws` are no longer
 * schema-inert -- the orchestrator narrows on each value rather than
 * string-templating the deployTarget into a generic block. */
function deploymentTargetSection(target: DeployTarget, deployConfig: Record<string, string>): string {
  switch (target) {
    case "docker-local":
      return [
        "### Compose-file target",
        "",
        `Compose file: \`${deployConfig.composePath ?? "./docker-compose.yml"}\``,
        "Bring up: `docker compose up -d`",
        "Verify: `docker compose ps`",
        "",
        "Use the existing compose file in source as the source of truth. Note healthcheck states and service connectivity in your summary. Tail logs before declaring deployed.",
      ].join("\n");
    case "aws":
      return [
        "### AWS target",
        "",
        `Region: \`${deployConfig.awsRegion ?? "(missing — your contract will be blocked)"}\``,
        `Credentials profile (env-resolved): \`${deployConfig.awsProfile ?? "default"}\``,
        "",
        "Read the existing repo's infrastructure code first — Dockerfile, compose, .aws/, terraform/, CloudFormation — and extend it rather than introducing a parallel scheme. Resource limits and idle behaviour come from the conventions in that code.",
        "",
        "Your contract REQUIRES `awsRegion` -- it is the audit trail showing where the resources actually landed. If you cannot determine it from `deployConfig.awsRegion` or the repo's existing infra code, set `status: \"blocked\"` with `blockedReason: \"missing awsRegion\"`.",
      ].join("\n");
    case "none":
      return "_No deployment target configured._";
  }
}
