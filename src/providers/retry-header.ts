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
