import type { AnthropicMessagesRequest } from "../types.js";

export interface ProviderResponse {
  status: number;
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
}

/** Priority bucket for the per-provider throttle. Lives next to
 * `CompleteOptions` so the wire type and the queue semantics share
 * one canonical union -- adding a third value (e.g. "system") only
 * needs to land here, not in two files. */
export type Priority = "interactive" | "background";

export interface CompleteOptions {
  signal?: AbortSignal;
  /** The `anthropic-beta` header the *client* sent, forwarded verbatim.
   * Claude Code gates newer request-body fields (e.g. context_management)
   * behind beta flags it declares here; Custos must pass them through or
   * Anthropic rejects the body as containing unpermitted extra inputs.
   * Only the Anthropic provider uses this -- OpenAI-compatible providers
   * ignore it. */
  clientBetaHeader?: string;
  /** The client's own first-party-identity headers (User-Agent, x-app,
   * x-claude-code-session-id, x-stainless-*, anthropic-dangerous-direct-
   * browser-access), forwarded verbatim. An OAuth token from a Claude
   * subscription login is meant to be used by Anthropic's own client
   * software, not arbitrary automation -- without these, every request
   * this gateway makes (regardless of how well-behaved its own
   * concurrency/rate-limiting is) looks like a bare, unbranded HTTP
   * client hitting an OAuth-gated endpoint rather than the genuine
   * Claude Code CLI the token was issued to, which is a much likelier
   * trigger for opaque, header-less 429s than anything about request
   * volume or timing. Only the Anthropic provider uses this. */
  clientIdentityHeaders?: Record<string, string>;
  /** Real model name for a request that arrived under a pinned
   * `custos:<provider>/<model>` alias. OpenAI-compatible instances
   * otherwise always send their own configured model and would ignore the
   * caller's choice, which defeats the point of pinning -- an engineering
   * manager that picked a specific model has to actually get it. Unset for
   * normally-routed requests, where the instance's configured model wins. */
  modelOverride?: string;
  /** Priority bucket for the per-provider throttle. Interactive
   * (default) requests jump the queue ahead of background requests --
   * the canonical case is a saturated local Ollama where mid-turn
   * chat requests should skip past queued memory-curator work.
   * `ProviderRouter.complete()` infers this from the task kind; direct
   * callers can set it themselves. Background requests only jump ahead
   * of interactive ones once the configurable age threshold is
   * exceeded, preventing interactive traffic from starving background
   * forever. */
  priority?: Priority;
}

export interface Provider {
  readonly name: string;
  complete(request: AnthropicMessagesRequest, options?: CompleteOptions): Promise<ProviderResponse>;
}
