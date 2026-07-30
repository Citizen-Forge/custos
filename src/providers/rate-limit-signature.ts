/**
 * Shared keyword matcher for "this upstream body describes a rate/quota
 * limit" -- used by both the pre-spawn probe (src/pm/probe.ts) and the
 * dispatch path (openai-compatible.ts) so the two don't drift on what
 * counts as "rate limited" for an upstream that doesn't use a plain 429.
 *
 * Groq is the motivating case: its TPM (tokens-per-minute) limit comes
 * back as HTTP 413 "Request too large ... on tokens per minute (TPM)"
 * rather than 429, which otherwise looks identical to a genuine
 * payload-too-large rejection. The dispatch path only treats 429/5xx as
 * `ProviderUnavailableError` (the trigger for cooldown + fallback-set
 * advance), so an upstream that reports its rate limit via 413 was
 * falling straight through as a normal (if erroring) response -- no
 * cooldown, no fallback, and the caller's own retry loop just hit the
 * same exhausted provider again.
 */
const RATE_LIMIT_PATTERN =
  /tokens per minute|tokens-per-minute|\bTPM\b|requests per minute|requests-per-minute|\bRPM\b|rate[- ]limit|usage[- ]limit|quota exceeded|exceeded.*quota|current quota/i;

export function looksRateLimited(text: string): boolean {
  return RATE_LIMIT_PATTERN.test(text);
}
