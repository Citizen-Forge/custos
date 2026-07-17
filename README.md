# Custos

An Anthropic-Messages-format proxy that Claude Code talks to instead of `api.anthropic.com` directly. It adds:

- **Multi-provider routing** — Anthropic (OAuth or API key) plus any number of named instances of any provider speaking the OpenAI chat-completions format: Ollama, OpenAI, DeepSeek, Gemini, Groq, Mistral, xAI, OpenRouter, or a custom endpoint. Per-task priority lists with automatic failover (e.g. Anthropic session/rate limit hit -> falls back to the next provider until it recovers).
- **Permission gating** — a `PreToolUse` hook backend. Read-only tools and a small set of argument-invariant-safe Bash verbs (`ls`, `cat`, `pwd`, etc. -- only when there's no shell redirection/chaining) pass instantly; everything else goes to an LLM classifier (`allow`/`deny`/`ask`) live, every single time. Deliberately no allow/deny caching beyond that static safe set: for commands like `rm`/`chmod`/`curl`, safety depends on arguments, not the verb, so caching by verb would let one benign invocation silently whitelist a catastrophic one later.
- **Context memory** — every `/v1/messages` exchange (streaming or not) is logged; a periodic curator extracts durable facts via an LLM and embeds them into Qdrant; a `UserPromptSubmit` hook does semantic search on each new prompt and injects relevant memory back into context.
- **Ask-outcome log** — a `PostToolUse` hook correlates calls the classifier returned `ask` for with whether they later executed, logged to `data/ask-outcomes.jsonl` for review. This is observability only, not a bypass: Claude Code has no documented hook that reports what a human actually clicked at the interactive permission prompt (`PermissionRequest` fires *before* the dialog, not after), so "it executed" can't be cleanly attributed to a human's yes vs. Claude Code's own permission system approving it independently.
- **Per-turn complexity routing** (opt-in) — classifies each fresh human message as low/medium/high complexity and routes it to a different tier of models (e.g. a cheap fast model for "what does this function do" vs. Claude for an architecture decision). Only fires on a fresh human turn, never on a tool-loop continuation hop -- reclassifying (and potentially swapping models) on every tool call within one logical request would be both wasteful and disruptive to the model's own train of thought mid-loop.
- **Admin UI** at `/admin` — configure providers (presets for the ones above, or a custom OpenAI-compatible endpoint, plus Anthropic OAuth/API key), task and complexity-tier routing priorities, and see the exact `ANTHROPIC_BASE_URL`/`settings.json` snippet to paste into Claude Code. Changes take effect immediately, no restart -- the server rebuilds its providers/router from the saved config on every admin change.
- **Remote control** — Anthropic's own Remote Control feature refuses to work once `ANTHROPIC_BASE_URL` points anywhere but `api.anthropic.com` (a deliberate restriction as of Claude Code v2.1.196), so it can't be used alongside this proxy. Custos runs its own instead: it spawns `claude` in a real pseudo-terminal inside the container and streams it to a browser tab over a WebSocket (the same pattern as ttyd/gotty), so you can steer a session from your phone or another computer. The spawned session's own `ANTHROPIC_BASE_URL` points back at Custos itself, so it gets the same permission gating/memory/routing as any other session.

## Why a proxy, not just hooks

Claude Code's own hook system can't do multi-provider routing or model-based classification on its own — hooks are per-event scripts/HTTP calls. This gateway is the always-on service those hooks (and Claude Code's `ANTHROPIC_BASE_URL`) talk to.

## Setup

```bash
docker compose build
docker compose up -d
```

Open **http://localhost:8787/admin** and:

1. **Connect Anthropic** — click "Connect via OAuth" (authenticates as your own Claude subscription the same way Claude Code's CLI login does: same client_id, same `claude.ai/oauth/authorize` flow -- this proxy is meant to sit in front of your own Claude Code traffic, not to resell/multiplex that session elsewhere) or paste in an API key as a fallback. If you never connect either, the gateway falls back to importing the OAuth token Claude Code itself is already logged in with from `~/.claude/.credentials.json`.
2. **Add/edit model provider instances** — defaults point at a local Ollama; add OpenAI, DeepSeek, Gemini, Groq, Mistral, xAI, OpenRouter, or a custom endpoint via the preset dropdown, with an API key if that provider needs one.
3. **Review task routing and complexity-tier priorities** — defaults are sane, but this is where you'd point the permission classifier at a specific fast model, add a third provider once one's configured, etc.
4. **Copy the setup snippet** at the bottom of the page into your shell and `~/.claude/settings.json`.

All of the above can also be done by hand: copy `config.example.json` to `data/config.json`, or run `docker compose run --rm gateway npm run login` for a terminal-based OAuth login instead of the admin UI's browser flow.

### Remote control

Set `CUSTOS_WORKSPACE` (in `.env` or your shell) to the host directory you want reachable remotely -- it gets bind-mounted to `/workspace`, which is where the remote session's `claude` process runs:

```bash
CUSTOS_WORKSPACE=/path/to/your/project docker compose up -d
```

Click **Start session** in the admin UI's Remote control panel and open the link it gives you (or open it on your phone). First connection needs its own `/login` inside that terminal, same as any fresh Claude Code install -- unless you've mounted your own `~/.claude` into the container (see the commented-out line in `docker-compose.yml`), in which case it reuses your existing login.

**The connect link is a bearer credential** -- anyone who has it can type into that session. It's not short-lived or rotated (unlike Anthropic's own Remote Control credentials); stopping the session is what invalidates it. Treat it like a password, and see the security note in Known limitations below before deciding whether to expose this past your own LAN.

## Point Claude Code at the gateway

```bash
export ANTHROPIC_BASE_URL=http://localhost:8787
```

## Wire up the hooks

Add to `~/.claude/settings.json` (the admin UI's setup panel has this pre-filled with your actual host/port):

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "hooks": [{ "type": "http", "url": "http://localhost:8787/hooks/pretooluse", "timeout": 30 }]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [{ "type": "http", "url": "http://localhost:8787/hooks/user-prompt-submit", "timeout": 15 }]
      }
    ],
    "PostToolUse": [
      {
        "hooks": [{ "type": "http", "url": "http://localhost:8787/hooks/posttooluse", "timeout": 10 }]
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
- The session-limit-aware cooldown reads Anthropic's documented rate-limit reset headers (`anthropic-ratelimit-unified-5h-reset`, etc.) but hasn't been exercised against a real 429 yet -- only verified by code review of the header names, not a live triggered limit.
- The admin UI has no authentication -- `docker-compose.yml` publishes port 8787 on `0.0.0.0`, so anything on your LAN can reach `/admin` and change providers, routing, or your OAuth connection, **and can start/stop/view remote-control sessions**. This matters more now than it used to: remote control means shell access to the container (and whatever host directory you've mounted at `/workspace`). Fine for a home network you trust; do not expose this port to the open internet without putting real authentication in front of it (e.g. a reverse proxy with its own auth, or a VPN/Tailscale rather than port-forwarding).
- Remote control supports one session at a time, and any client holding the link can both view and type -- there's no separate read-only/view-only mode, and no per-device revocation short of stopping the whole session.
- Complexity routing's classifier prompt hasn't been tuned/evaluated beyond a handful of manual test cases (a trivial question, a deliberately complex architecture question, a tool-continuation turn) -- tier boundaries are a first guess, not calibrated.
