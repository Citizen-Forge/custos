# Custos

A self-hosted, agentic software development lifecycle. An idea goes in one end, gets argued with, shaped into epics and stories, implemented by engineer agents in isolated git worktrees, reviewed by a QA agent that actually runs the code, and deployed — with every step visible, priced, and switch-off-able.

Underneath it is a multi-provider LLM gateway (Custos started life as one), which is what makes the agents switchable and cheap: each one is pinned to a specific provider and model, and the engineering manager picks that pairing per ticket based on how hard the work is, what's still available, and what it costs.

## The lifecycle

Every project has four tabs, and work only moves one way through them. Each handoff is a real artifact — a brief, an epic, a ticket, a branch, a PR, a QA verdict — not a prompt passed between bots.

- **Steering Co** — adversarial ideation. Runs on the project's strongest model with a persona whose job is to stress-test an idea rather than agree with it: one question at a time, always with a recommended answer, researching anything the repo can answer instead of asking. The only way out is a handoff block, which drops a brief into the roadmap inbox.
- **Product Roadmap** — an inbox of handed-off ideas, and the epics a **product owner** agent breaks them into (INVEST-shaped stories, testable acceptance criteria, with its research written down). It owns exactly one transition: backlog → ready.
- **Board** — a kanban board (backlog → ready → in progress → QA → complete). An **engineering manager** sizes each ticket and assigns it; **engineer** agents implement in their own worktrees; a **QA** agent verifies each acceptance criterion by running the code, and passes or bounces.
- **DevOps** — deploy target, budgets, autonomy switches, the killswitch, the secrets vault, the model registry, the agent roster and the live run feed. A **devops** agent creates the project's repository and deploys verified work.

Role transitions are **enforced in the store, not requested in a prompt**: an engineer can only push to QA, so it can never mark its own work complete however confidently it claims to have finished. Humans are unrestricted — the board is yours.

## Intelligent use of providers

The point is to keep the pipeline moving without spending more than the work is worth.

- Every provider/model pairing is classified as **subscription** (flat-rate, but with a usage window that runs out), **metered** (per-token, against a budget), or **free** (local or free tier — unmetered, usually rate limited and less capable).
- **Availability is learned from the providers themselves.** A 429 carries its own reset time, so when a subscription window is exhausted the gateway records exactly that, and the engineering manager routes around it — pulling simple tickets forward onto free capacity rather than stalling the board.
- **Capability is measured, not assumed.** Each pairing carries a 1–5 rating seeded from its tier and then moved by QA's verdicts on work that model produced. Failures move it down twice as fast as successes move it up. The manager reads that when deciding who gets the hard tickets, and is told to trust it over the model's name.
- Agents are pinned via a `custos:<provider>/<model>` alias passed as `ANTHROPIC_MODEL`, which overrides task and complexity routing outright — a deliberate choice to run something on a free local model is honoured, not re-routed.

## Running agents safely

- **Autonomy is off by default** for every role except the product owner. With a role off, its work happens only when you press the button for it — which is how you watch an agent before handing it the keys.
- **A killswitch per project** aborts every running agent immediately and blocks further dispatch. Persisted, so nothing resumes quietly on restart.
- **Budgets are hard limits**, and only *metered* spend counts against them — work covered by a Claude subscription or a local model doesn't draw down a cap it never cost anything against.
- **Live telemetry, not self-reporting.** Every tool call updates the run's last-activity time and current action, so the UI shows what each agent is doing right now. Stalls are detected from that (measured, not asserted — the agent least able to notice it's stuck is a stuck one), and a hard wall-clock timeout aborts a run that isn't converging.
- **Secrets live in an encrypted vault**, injected into agent runs as environment variables. Nothing can read a value back — not the UI, not the API — and agent output is scanned so a token that gets echoed is redacted before it can reach a ticket or a log.
- **A shared project knowledge store** every agent reads at the start of every run and any of them can write to, so what DevOps learns (where the repo is) reaches the engineers, and what QA works out (how to run the suite) survives past its own run.

## Interfaces

- **Web UI at `/app`** — the four tabs in a browser, served from Custos itself.
- **Desktop client** ([custos-desktop](https://github.com/Citizen-Forge/custos-desktop)) — the same application; the Electron shell asks which server and password, then hands its window to the hosted UI.
- **Admin panel at `/admin`** — provider configuration, routing priorities, security.

## The gateway underneath

All of the above runs on the original proxy, which Claude Code talks to instead of `api.anthropic.com` directly:

- **Multi-provider routing** — Anthropic (OAuth or API key) plus any number of named instances of any provider speaking the OpenAI chat-completions format: Ollama, OpenAI, DeepSeek, Gemini, Groq, Mistral, xAI, OpenRouter, or a custom endpoint. Per-task priority lists with automatic failover (e.g. Anthropic session/rate limit hit -> falls back to the next provider until it recovers).
- **Permission gating** — a `PreToolUse` hook backend. Read-only tools and a small set of argument-invariant-safe Bash verbs (`ls`, `cat`, `pwd`, etc. -- only when there's no shell redirection/chaining) pass instantly; everything else goes to an LLM classifier (`allow`/`deny`/`ask`) live, every single time. Deliberately no allow/deny caching beyond that static safe set: for commands like `rm`/`chmod`/`curl`, safety depends on arguments, not the verb, so caching by verb would let one benign invocation silently whitelist a catastrophic one later.
- **Context memory** — every `/v1/messages` exchange (streaming or not) is logged; a periodic curator extracts durable facts via an LLM and embeds them into Qdrant; a `UserPromptSubmit` hook does semantic search on each new prompt and injects relevant memory back into context.
- **Ask-outcome log** — a `PostToolUse` hook correlates calls the classifier returned `ask` for with whether they later executed, logged to `data/ask-outcomes.jsonl` for review. This is observability only, not a bypass: Claude Code has no documented hook that reports what a human actually clicked at the interactive permission prompt (`PermissionRequest` fires *before* the dialog, not after), so "it executed" can't be cleanly attributed to a human's yes vs. Claude Code's own permission system approving it independently.
- **Per-turn complexity routing** (opt-in) — classifies each fresh human message as low/medium/high complexity and routes it to a different tier of models (e.g. a cheap fast model for "what does this function do" vs. Claude for an architecture decision). Only fires on a fresh human turn, never on a tool-loop continuation hop -- reclassifying (and potentially swapping models) on every tool call within one logical request would be both wasteful and disruptive to the model's own train of thought mid-loop.
- **Admin UI** at `/admin` — configure providers (presets for the ones above, or a custom OpenAI-compatible endpoint, plus Anthropic OAuth/API key), task and complexity-tier routing priorities, and see the exact `ANTHROPIC_BASE_URL`/`settings.json` snippet to paste into Claude Code. Changes take effect immediately, no restart -- the server rebuilds its providers/router from the saved config on every admin change.
- **Remote control, organized into projects** — Anthropic's own Remote Control feature refuses to work once `ANTHROPIC_BASE_URL` points anywhere but `api.anthropic.com` (a deliberate restriction as of Claude Code v2.1.196), so it can't be used alongside this proxy. Custos runs its own instead: **projects** are workspace folders (e.g. one per app you work on), and each project can have any number of **chats** running concurrently -- each chat turn spawns a one-shot `claude -p` process inside the container, scoped to that project's folder, and streams its parsed events over a WebSocket so you can steer it from a browser, your phone, or the [desktop client](https://github.com/Citizen-Forge/custos-desktop). Turns are stitched into one conversation with `--resume` (Claude Code has no persistent multi-turn headless mode, so each turn really is a fresh process). Each spawned chat's own `ANTHROPIC_BASE_URL` points back at Custos itself, so it gets the same permission gating/memory/routing as any other session.

  In `-p` mode there's no TTY for Claude Code's own interactive permission prompt, so anything the classifier doesn't outright allow is surfaced **in the transcript** as an approval request and the hook blocks until you answer. Autonomous PM agent runs use a different posture — nobody is attached to ask, so `ask` proceeds and only a hard `deny` blocks, which is exactly why autonomy is opt-in per role.

  **Important:** this spawns a *new* session on whatever machine Custos itself runs on -- it does not attach to, view, or control a Claude Code session you already have running elsewhere (a terminal, VS Code, wherever). There's no general mechanism to do that: a PTY is host-local, and VS Code extension sessions in particular maintain completely separate history from CLI sessions by design (confirmed against Claude Code's own docs), so nothing running outside VS Code can reach them at all. If you want remote control to reach the same machine and files you actually develop on, run Custos there.

  Instead of literal session-attach, Custos offers **resume-by-summary**: since every `/v1/messages` exchange gets logged regardless of which surface it came from (CLI, VS Code, anywhere pointed at this proxy), the Remote control panel lists recent conversations and can start a new session primed with an LLM-generated summary of one, passed as the initial prompt. This is *not* a literal replay of the original conversation -- doing that properly would mean reverse-engineering Claude Code's own internal transcript format, an undocumented implementation detail Anthropic can change at will. It's "Claude opens already knowing roughly what you were working on," not "picks up mid-keystroke."
- **Password-protected admin/remote access** — `/admin` and `/remote` (including the WebSocket itself, not just the page) require a session cookie from `/login`. A random password is generated on first boot and printed to the container logs once if you don't set `ADMIN_PASSWORD` yourself; change it later from the admin UI's Security panel.
- **Client API key, fails closed** — `/v1/messages`, `/hooks/*`, and `/memory/search` (everything a Claude Code instance calls directly) require a matching `x-api-key` header -- the same header Claude Code already sends for real Anthropic API-key auth, repurposed here since Custos ignores whatever the client sends for upstream purposes anyway (it does its own provider auth server-side). There's no open mode: until you generate a key from the admin UI's Security panel, every request on that surface is rejected. Without this, anyone who can reach the endpoint could point their own Claude Code at your instance and burn your configured providers' budget/compute for free.
- **Budget-based fallback** — give a provider instance a $/million-token price and a spend cap, and once that cap is hit for the current period, the router treats it as unavailable and falls through to the next entry in the priority list -- same mechanism as the existing rate-limit cooldown, just triggered by cumulative cost instead of a 429. Useful for a chain like "OpenAI (budget-capped) -> Claude (session-limit fallback) -> local models."

## Why a proxy, not just hooks

Claude Code's own hook system can't do multi-provider routing or model-based classification on its own — hooks are per-event scripts/HTTP calls. This gateway is the always-on service those hooks (and Claude Code's `ANTHROPIC_BASE_URL`) talk to.

## Setup

```bash
docker compose build
docker compose up -d
```

Check the container logs for a generated admin password (`docker compose logs gateway`), or set `ADMIN_PASSWORD` in `.env` before first boot to choose your own.

Signing in lands you on **http://localhost:8787/app** — the project UI with the four tabs. Provider and routing configuration lives behind it at **/admin** (also reachable from the app's Settings tab):

1. **Connect Anthropic** — click "Connect via OAuth" (authenticates as your own Claude subscription the same way Claude Code's CLI login does: same client_id, same `claude.ai/oauth/authorize` flow -- this proxy is meant to sit in front of your own Claude Code traffic, not to resell/multiplex that session elsewhere) or paste in an API key as a fallback. If you never connect either, the gateway falls back to importing the OAuth token Claude Code itself is already logged in with from `~/.claude/.credentials.json`.
2. **Add/edit model provider instances** — defaults point at a local Ollama; add OpenAI, DeepSeek, Gemini, Groq, Mistral, xAI, OpenRouter, or a custom endpoint via the preset dropdown, with an API key if that provider needs one.
3. **Review task routing and complexity-tier priorities** — defaults are sane, but this is where you'd point the permission classifier at a specific fast model, add a third provider once one's configured, etc.
4. **Generate a client API key** in the Security panel -- required, not optional: `/v1/messages`/`/hooks/*`/`/memory/search` reject everything until a key exists.
5. **Copy the setup snippet** at the bottom of the page into your shell and `~/.claude/settings.json` -- it already includes the client key in both the `ANTHROPIC_API_KEY` export and each hook's `headers` once you've generated one.

All of the above can also be done by hand: copy `config.example.json` to `data/config.json`, or run `docker compose run --rm gateway npm run login` for a terminal-based OAuth login instead of the admin UI's browser flow.

### Remote control

Set `CUSTOS_WORKSPACE` (in `.env` or your shell) to the host directory you want reachable -- it gets bind-mounted to `/workspace`, which is the root every project's own subfolder lives under. **Point it at a dedicated projects directory, not a broad share**: it is the entire visible filesystem for every agent Custos spawns, and autonomous engineers get write access to all of it.

```bash
CUSTOS_WORKSPACE=/path/to/your/projects docker compose up -d
```

In the admin UI's **Projects** panel, click **New project** -- this creates a subfolder under `/workspace` (named from the project name, deduplicated if it already exists) and every chat you start in that project runs `claude` there. Click **New chat**, then open the connect link it gives you (or open it on your phone). First connection needs its own `/login` inside that terminal, same as any fresh Claude Code install -- unless you've mounted your own `~/.claude` into the container (see the commented-out line in `docker-compose.yml`), in which case it reuses your existing login.

Chats within a project (and across different projects) run concurrently -- there's no limit like the old single-session model had. **Stop** ends a chat's live process (its history stays in the project's chat list); **Reopen** starts a fresh `claude` process for that same chat entry in the same folder, but -- since there's no way to persist Claude Code's own in-process conversation state across a process exit -- it's a clean start, not a continuation. For actual continuity, use **Resume into project** instead: it primes a new chat with an LLM-generated summary of a past conversation (see resume-by-summary above).

**The connect link is a bearer credential** -- anyone who has it can type into that session. It's not short-lived or rotated (unlike Anthropic's own Remote Control credentials); stopping the session is what invalidates it. Treat it like a password, and see the security note in Known limitations below before deciding whether to expose this past your own LAN.

## Point Claude Code at the gateway

```bash
export ANTHROPIC_BASE_URL=http://localhost:8787
export ANTHROPIC_API_KEY=<the client key generated in the admin UI's Security panel>
```

`ANTHROPIC_API_KEY` here is not a real Anthropic key -- it's Custos's own client key, sent as `x-api-key` and checked by Custos itself before anything reaches a provider. The real upstream credentials (OAuth or a real API key) are configured separately, server-side, in the admin UI.

## Wire up the hooks

Add to `~/.claude/settings.json` (the admin UI's setup panel has this pre-filled with your actual host/port and client key):

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "hooks": [{ "type": "http", "url": "http://localhost:8787/hooks/pretooluse", "timeout": 30, "headers": { "x-api-key": "<client key>" } }]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [{ "type": "http", "url": "http://localhost:8787/hooks/user-prompt-submit", "timeout": 15, "headers": { "x-api-key": "<client key>" } }]
      }
    ],
    "PostToolUse": [
      {
        "hooks": [{ "type": "http", "url": "http://localhost:8787/hooks/posttooluse", "timeout": 10, "headers": { "x-api-key": "<client key>" } }]
      }
    ]
  }
}
```

Note that you already have `claude-permission-hook.exe` registered on `PreToolUse` with matcher `.*` -- adding Custos's hook means two PreToolUse hooks fire on every tool call. How Claude Code combines two hook verdicts (whether a `deny` from either wins, or `ask` overrides `allow`, etc.) hasn't been confirmed against the docs -- check that before relying on both being active together.

`PostToolUse` is optional: it only powers the best-effort ask-outcome log described below, nothing else depends on it.

## Known limitations (v1)

- The OpenAI-compatible translation layer handles one text block and one tool call per turn; it doesn't multiplex true parallel tool calls in a single turn. Only verified live against Ollama -- DeepSeek/Gemini/Groq/Mistral/xAI/OpenRouter all claim OpenAI compatibility but haven't been individually tested through this proxy, and tool-calling fidelity in particular can vary by provider.
- Session boundaries for memory ingestion are approximate — the Messages API carries no stable conversation id, so the curator works off rolling daily logs rather than exact per-session grouping.
- The OAuth client_id/endpoints are reverse-engineered (matching Claude Code's own login flow); Anthropic can change or restrict them without notice.
- The session-limit-aware cooldown reads Anthropic's documented rate-limit reset headers (`anthropic-ratelimit-unified-5h-reset`, etc.). This *has* now been exercised against a real exhausted 5-hour window, and it exposed two things worth knowing: with several agents running, the pinned-provider path has no failover by design, so hitting the limit stops the board until either the window resets or the engineering manager reassigns to another provider; and concurrent token refreshes used to race each other over a single-use rotating refresh token, corrupting the stored credentials (fixed -- refreshes are now collapsed into one in-flight request, but reconnect OAuth once if you hit this before the fix).
- Agent runs report their outcome through a JSON contract block. Parsing is deliberately forgiving (fenced block, then any balanced JSON object, string-aware) because a parse failure discards work that has already been paid for -- an engineer's summary containing a markdown code fence used to be enough to lose a completed ticket.
- Capability ratings need evidence before they move (3+ samples), so a brand-new provider is trusted at its seeded tier for its first few tickets. The seeds are a guess, not a benchmark.
- A project that isn't a git repository, or is one with no commits yet, can't have isolated worktrees -- so it's clamped to one engineer at a time until DevOps has created the repo and pushed a first commit.
- `CUSTOS_WORKSPACE` is the entire filesystem as far as an autonomous agent is concerned. Point it at a directory containing only the projects Custos should be able to touch; pointing it at a broad share hands every engineer agent write access to all of it.
- Sessions are in-memory only -- restarting the container logs everyone out. Prefer a VPN/Tailscale over raw port-forwarding if you want remote access beyond your LAN, even with the admin login and client API key both in place -- defense in depth is still worth it for something that can spend your API budget or run tool calls.
- Any client holding a chat's connect link can both view and type -- there's no separate read-only/view-only mode, and no per-device revocation short of stopping that chat. The admin login is a real improvement here (you now need both the admin password *and* the link), but the link itself still doesn't rotate/expire independently.
- Projects and chat metadata (titles, which folder, when created) persist in `data/`, and Claude Code's own transcripts now persist too (`./data/claude-home` is mounted at `/root/.claude`), so reopening a chat genuinely resumes it. Restarting the container still ends any *running* turn or agent run -- those are marked failed on the next boot rather than left as ghosts.
- Budget tracking uses a fixed-window reset, not a true rolling window: once `periodDays` elapses since the window started, the next request resets the counter rather than old spend decaying continuously. Anthropic isn't covered by budget tracking yet, only `openaiCompatibleInstances` -- the user's own motivating example (OpenAI budget-capped, then Claude via its existing session-limit fallback) doesn't need it there anyway.
- Complexity routing's classifier prompt hasn't been tuned/evaluated beyond a handful of manual test cases (a trivial question, a deliberately complex architecture question, a tool-continuation turn) -- tier boundaries are a first guess, not calibrated.
- The resume-conversation picker groups raw exchange logs heuristically (a change in the first message signals a new conversation, since there's no real conversation id anywhere in the Messages API traffic itself) -- good enough for a picker, not a guarantee. Only scans the last ~14 days of logs.
