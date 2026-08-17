/** Every built-in Claude Code tool -- used to give a purely-judgment task
 *  literally none of them. A decision made entirely from content already
 *  in its prompt has no legitimate reason to touch the filesystem, run a
 *  command, or fetch a URL. Observed live: with full tool access and
 *  `cwd` pointed at the real project checkout, both the engineering
 *  manager's assignReady and the product owner's groomBacklog kept
 *  exploring the codebase (including spawning a `Task` sub-agent that
 *  can run silently for many minutes) or starting to implement code for
 *  whatever ticket's description read like an interesting problem -- a
 *  prose "don't do this" in the prompt was not enough to stop a model
 *  that has the tools sitting right there. A denied tool can't be
 *  invoked regardless of what the model decides. */
// Not exhaustive by construction -- see DISALLOWED_TOOLS_BY_TAG below for why
// that matters. Extended live 2026-08-11 after an engineering-manager run
// called TaskList/CronList/ListAgents (a task/cron/agent-orchestration
// family of built-ins that didn't exist when this list was first written)
// instead of assign_ticket -- add newly-observed built-ins here as they
// turn up, but don't treat this list as ever being complete.
const ALL_TOOLS = [
  "Bash", "BashOutput", "KillShell", "Read", "Write", "Edit", "NotebookEdit", "Glob", "Grep", "WebFetch", "WebSearch",
  "Task", "TaskCreate", "TaskList", "TaskOutput", "TaskStop", "TodoWrite", "SlashCommand",
  "CronCreate", "CronDelete", "CronList", "ListAgents", "SendMessage",
  "EnterPlanMode", "ExitPlanMode", "EnterWorktree", "ExitWorktree", "Monitor",
  "DesignSync", "PushNotification", "RemoteTrigger", "ScheduleWakeup", "AskUserQuestion", "ReportFindings",
];

/** Tool names hard-denied per TASK (keyed by the same `tag` passed to
 *  runAgent, e.g. "custos-groom"), NOT per agent role. This matters
 *  because product-owner drives two different tasks that need
 *  genuinely different tool access from the SAME agent/role: groomBacklog
 *  (custos-groom) is a pure sizing/promote/comment decision on tickets
 *  already fully described in its prompt, with nothing to gain from the
 *  filesystem -- but planIdea (custos-plan) explicitly instructs the
 *  agent to "Research the workspace and the web as needed before you
 *  decide on the shape," a real, legitimate need for Read/Glob/Grep/
 *  WebFetch/WebSearch. Keying by role alone would have to pick one
 *  answer for both tasks; keying by tag lets custos-groom go tool-free
 *  while custos-plan keeps full access.
 *
 *  QA (custos-qa) legitimately needs Read/Bash/Glob/Grep to check out and
 *  run the diff it's reviewing, and Task to delegate exploration -- but
 *  never Write/Edit/NotebookEdit, since its whole point is judging the
 *  engineer's diff, not modifying it. custos-qa is governed by
 *  TOOL_ALLOWLIST_BY_TAG below instead of an entry here -- see that
 *  export's comment for why a denylist doesn't get it.
 *
 *  custos-assign-models (the PM's once-per-project fallback-set
 *  assignment pass) belongs in the same tool-free bucket as
 *  custos-groom/-assign/-curate for the identical reason -- its entire
 *  prompt is self-contained (budget, roster, fallback-set menu), nothing
 *  to gain from touching the filesystem -- but was missed when it was
 *  added, so it kept its full, unrestricted default. Found live
 *  2026-08-17: a brand-new project's PM agent sat with 0 completed runs
 *  for 3+ hours, retrying every ~20s against a capped local provider --
 *  same root cause as the custos-qa case above (a pure-judgment task's
 *  unrestricted tool-schema floor alone exceeded the provider's request
 *  cap before a single byte of real content), just never diagnosed
 *  because nothing about a brand-new, unconfigured project stood out as
 *  the trigger.
 *
 *  Tags not listed in either map keep full tool access: they have a
 *  real, legitimate reason to touch the filesystem or run commands. */
export const DISALLOWED_TOOLS_BY_TAG: Record<string, string[]> = {
  "custos-assign": ALL_TOOLS,
  "custos-groom": ALL_TOOLS,
  "custos-curate": ALL_TOOLS,
  "custos-assign-models": ALL_TOOLS,
};

/** Tags whose entire legitimate action surface is their MCP tools (see
 *  mcp/pm-tools.ts) and nothing else -- these get `--tools []` (RunTurnOptions.tools,
 *  the CLI's own `--tools ""`) on top of DISALLOWED_TOOLS_BY_TAG's denylist,
 *  cutting every built-in tool from the roster instead of hoping the
 *  denylist happens to name whatever the model tries. Confirmed necessary
 *  live: `--disallowedTools` alone kept missing newer built-ins (TaskCreate,
 *  TaskList, CronList, ListAgents -- a task/cron/agent-orchestration family
 *  that didn't exist when ALL_TOOLS was first written), and the model used
 *  each one instead of the MCP tool it was actually given, burning a full,
 *  slow turn per miss. MCP-server tools are unaffected by `--tools` -- it
 *  only governs the built-in roster -- so this doesn't touch the very
 *  tools these tags exist to use. */
export const TOOL_FREE_TAGS = new Set(["custos-groom", "custos-assign", "custos-curate", "custos-assign-models"]);

/** Tags with an explicit tool ALLOWLIST (RunTurnOptions.tools, the CLI's
 *  own `--tools`) instead of DISALLOWED_TOOLS_BY_TAG's denylist. A denylist
 *  leaves in every built-in it doesn't name, and Claude Code's roster keeps
 *  growing (BashOutput, KillShell, SlashCommand, ExitPlanMode, ...) -- a
 *  role with a small, known tool need pays the full tool-schema JSON for
 *  all of those on every request regardless of ever calling them. Measured
 *  live 2026-08-17 investigating a recurring "Request too large" failure on
 *  a 45,000B-capped local provider: custos-qa's request floor (system
 *  prompt + tool schemas, before a single byte of ticket content) was
 *  ~92.7KB under the old denylist (Write/Edit/NotebookEdit excluded, all
 *  built-ins) vs ~23.6KB with this allowlist of exactly the 5 tools it
 *  legitimately uses -- the gap was entirely built-ins QA never calls.
 *  That ~92.7KB floor alone was already over-cap before any real
 *  conversation content, on every single QA run against that provider. */
export const TOOL_ALLOWLIST_BY_TAG: Record<string, string[]> = {
  "custos-qa": ["Read", "Bash", "Glob", "Grep", "Task"],
};
