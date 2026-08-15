/**
 * RFC 7231 `Retry-After` parser shared by every provider wrapping an
 * upstream HTTP API. Single source of truth so Anthropic and
 * OpenAI-compat providers share the same retry-after-seconds-and-
 * HTTP-date parsing without each implementing it inline.
 *
 * Two accepted shapes:
 *
 *   1. Plain decimal seconds: `Retry-After: 30` → 30_000ms
 *   2. HTTP-date: `Retry-After: Wed, 21 Oct 2026 07:28:00 GMT` →
 *      ms until that instant.
 *
 * Returns `undefined` for missing / unparseable values, which lets the
 * router's `CooldownTracker` fall back to its 60-second default — so
 * an upstream that omits Retry-After still gets a sane cooldown
 * rather than a fabricated value or zero-wait.
 *
 * Negative results are clamped to 0 (clock-skew between client /
 * server can produce a parsed instant in the past). The clamp keeps
 * the cooldown deadline from landing before `Date.now()`, which would
 * trigger an immediate re-attempt — that's the exact pattern the
 * user reported before this fix was in: the gateway kept calling the
 * upstream while it was still throttling, getting refused again,
 * looping until the quota reset. A 0-clamp still threads `undefined`
 * callers toward the default-cooldown path on the next attempt.
 */
export function parseRetryAfterMs(headers: Headers): number | undefined {
  const header = headers.get("retry-after");
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const dateMs = Date.parse(header) - Date.now();
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs);
  return undefined;
}

/**
 * Google Cloud APIs (Gemini included) don't put retry guidance in a
 * `Retry-After` header at all -- quota-exhaustion errors carry it in the
 * response BODY instead, as a `google.rpc.RetryInfo` entry under
 * `error.details[]`:
 *
 *   { "error": { "code": 429, "details": [
 *       { "@type": "type.googleapis.com/google.rpc.RetryInfo",
 *         "retryDelay": "19s" } ] } }
 *
 * Confirmed live: a real Gemini free-tier quota-exhaustion 429 with this
 * exact shape and no Retry-After header at all. Without this parser,
 * parseRetryAfterMs(res.headers) always returns undefined for these,
 * silently downgrading to whatever default/fallback cooldown applies --
 * on a provider with a short rpmLimit-driven spacing gate and no
 * explicit cooldownFallbackMs, that default was short enough that the
 * gateway kept re-hitting the still-exhausted quota every few seconds
 * instead of waiting out the ~20s Google actually asked for, forever.
 *
 * `retryDelay` is itself a protobuf Duration string: a decimal number of
 * seconds with a trailing "s" (e.g. "19s", "19.940059881s") -- never an
 * HTTP-date, unlike Retry-After.
 */
export function parseGoogleRetryDelayMs(bodyText: string): number | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return undefined;
  }
  // Gemini's OpenAI-compat error responses are sometimes wrapped in a
  // top-level array (`[{ "error": {...} }]`); the Google-native shape is
  // a bare object. Check the first array element too rather than assume
  // one shape.
  const candidates = Array.isArray(parsed) ? parsed : [parsed];
  for (const candidate of candidates) {
    const details = (candidate as { error?: { details?: unknown } } | undefined)?.error?.details;
    if (!Array.isArray(details)) continue;
    for (const entry of details) {
      const retryDelay = (entry as { retryDelay?: unknown } | undefined)?.retryDelay;
      if (typeof retryDelay !== "string") continue;
      const match = /^(\d+(?:\.\d+)?)s$/.exec(retryDelay);
      if (!match) continue;
      return Math.max(0, Math.round(parseFloat(match[1]) * 1000));
    }
  }
  return undefined;
}

/** Combines both retry-guidance channels a 429/5xx response might carry:
 *  the standard `Retry-After` header first (the more universally-
 *  supported mechanism when present), falling back to Google's body-
 *  embedded RetryInfo for upstreams (Gemini) that use that convention
 *  instead. Returns undefined only when NEITHER is present/parseable,
 *  which still leaves the caller's own default-cooldown path intact --
 *  this never fabricates a value. */
export function parseUpstreamRetryDelayMs(headers: Headers, bodyText: string): number | undefined {
  return parseRetryAfterMs(headers) ?? parseGoogleRetryDelayMs(bodyText);
}
