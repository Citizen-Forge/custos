# Custos

An Anthropic-Messages-format proxy that Claude Code talks to instead of `api.anthropic.com` directly. It adds:

- **Multi-provider routing** — Anthropic (OAuth or API key) and a local Ollama server, with per-task priority lists and automatic failover (e.g. Anthropic session/rate limit hit -> falls back to Ollama until it recovers).
- **Permission gating** — a `PreToolUse` hook backend with a learned whitelist. Read-only tools always pass; unseen actions go to an LLM classifier (`allow`/`deny`/`ask`); allow/deny decisions are cached so the same class of action isn't re-classified every time.
- **Context memory** — every `/v1/messages` exchange is logged; a periodic curator extracts durable facts via an LLM and embeds them into Qdrant; a `UserPromptSubmit` hook does semantic search on each new prompt and injects relevant memory back into context.

## Why a proxy, not just hooks

Claude Code's own hook system can't do multi-provider routing or model-based classification on its own — hooks are per-event scripts/HTTP calls. This gateway is the always-on service those hooks (and Claude Code's `ANTHROPIC_BASE_URL`) talk to.

## Setup

```bash
docker compose build
docker compose up -d qdrant   # start the vector store first
docker compose run --rm gateway npm run login   # interactive OAuth login (paste the code#state string back)
docker compose up -d
```

The login flow authenticates as your own Claude subscription the same way Claude Code's CLI login does (same client_id, same `claude.ai/oauth/authorize` flow) — this proxy is meant to sit in front of your own Claude Code traffic, not to resell/multiplex that session elsewhere. Tokens are stored in `data/credentials.json` and refreshed automatically. If you never run `npm run login`, the gateway will import the OAuth token Claude Code itself is already logged in with from `~/.claude/.credentials.json` on first use.

Optionally set `ANTHROPIC_API_KEY` (copy `.env.example` to `.env`) as a fallback path if OAuth ever gets rejected outright.

Copy `config.example.json` to `data/config.json` to customize providers, models, and per-task priority.

## Point Claude Code at the gateway

```bash
export ANTHROPIC_BASE_URL=http://localhost:8787
```

## Wire up the hooks

Add to `~/.claude/settings.json`:

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
    ]
  }
}
```

## Known limitations (v1)

- Streaming (`stream: true`) responses are relayed live but not yet ingested into memory — only non-streaming exchanges get curated. Most Claude Code traffic is streaming, so the curator currently sees a partial slice of activity; buffering+teeing streamed responses into ingestion is the natural next step.
- The Ollama translation layer handles one text block and one tool call per turn; it doesn't multiplex true parallel tool calls in a single turn.
- The permission whitelist only caches `allow`/`deny`; an `ask` decision hands off to Claude Code's normal interactive prompt and the human's actual answer isn't fed back into the whitelist yet (would need a `PostToolUse`/`Notification` hook to close that loop).
- Session boundaries for memory ingestion are approximate — the Messages API carries no stable conversation id, so the curator works off rolling daily logs rather than exact per-session grouping.
- The OAuth client_id/endpoints are reverse-engineered (matching Claude Code's own login flow); Anthropic can change or restrict them without notice.
