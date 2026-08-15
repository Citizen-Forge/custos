// Text-truncation fallback path: once image-stripping (fit-size.ts's
// fitRequestToSize) has nothing left to strip, this is the last resort
// for bringing a request under a provider's request-size cap.
import { OMITTED_IMAGE_PLACEHOLDER, isInlineBase64ImagePart, serializeRequestBytes, type FitRequestResult } from "./shared.js";
import type { OpenAIMessage, OpenAIRequest, OpenAITextPart } from "../types.js";

/** Helper: try to fit a single message's content under the size cap by
 *  truncating oversized text portions. Handles both string content
 *  (existing behavior — keep head 60 % / tail 40 %) and array content
 *  (agent conversations with tool results, file reads, etc.). Mutates
 *  `messages[idx].content` in place when truncation is possible.
 *  Returns `{ fits: boolean, bytes: number }` — the `bytes` field
 *  lets the caller avoid a redundant re-serialization.
 *
 *  For array content, the function finds the largest text parts and
 *  truncates them progressively (keeping head ~60 % / tail ~40 %),
 *  skipping parts whose text is already small (< 1 KB). Inline base64
 *  image parts are replaced with the text placeholder since they are
 *  the largest per-part byte consumers. Returns `{ fits: false }`
 *  when even the content at index 0 (system prompt) alone exceeds the
 *  cap — no amount of per-part truncation can save it. */
function truncateMessageContent(
  messages: OpenAIMessage[],
  idx: number,
  maxBytes: number,
  tools?: { type: "function"; function: { name: string; description?: string; parameters: unknown } }[],
): { fits: boolean; bytes: number } {
  const msg = messages[idx];
  const measure = () => serializeRequestBytes({ model: "", messages, tools: tools ?? undefined, max_tokens: undefined, stream: undefined });
  if (typeof msg.content === "string") {
    // Keep truncating until under the cap or the content is too small to
    // continue.  A single pass to 25 % may not suffice when the content
    // is enormous (a tool result with a 100 MB file), so we progressively
    // reduce the target fraction (0.25, 0.15, 0.10, 0.05) until the
    // request fits or the content is below 100 KB (truncating further
    // wouldn't save much).
    if (msg.content.length <= 1024) return { fits: false, bytes: 0 };
    const fractions = [0.25, 0.15, 0.10, 0.05];
    for (const frac of fractions) {
      const target = Math.max(512, Math.floor(msg.content.length * frac));
      msg.content = msg.content.slice(0, Math.floor(target * 0.6)) +
        "\n...[truncated by Custos to fit request size limit]...\n" +
        msg.content.slice(-Math.floor(target * 0.4));
      const bytes = measure();
      if (bytes <= maxBytes) return { fits: true, bytes };
      // If text is already small enough that further truncation is
      // unlikely to help, stop early.
      if (msg.content.length < 100 * 1024) break;
    }
    // Still over after the most aggressive truncation — measure once more
    // and return the result.
    return { fits: false, bytes: measure() };
  }
  if (Array.isArray(msg.content)) {
    const parts = msg.content;
    let changed = false;

    // Pass 1: replace inline base64 images with the text placeholder.
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (isInlineBase64ImagePart(p)) {
        parts[i] = OMITTED_IMAGE_PLACEHOLDER;
        changed = true;
      }
    }
    if (changed) {
      const bytes = measure();
      if (bytes <= maxBytes) return { fits: true, bytes };
    }

    // Pass 2: find and truncate the largest text parts, one at a time,
    // until under the cap or no part is > 1 KB.  Each text part gets
    // the same progressive-fraction treatment as the string branch
    // (0.25 → 0.15 → 0.10 → 0.05) so a single enormous tool-result
    // text is progressively reduced until the full request fits.
    const textParts: Array<{ idx: number; part: OpenAITextPart }> = [];
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (p.type === "text" && p.text.length > 1024) {
        textParts.push({ idx: i, part: p });
      }
    }

    // Sort largest-first by text byte length.
    textParts.sort((a, b) => Buffer.byteLength(b.part.text, "utf8") - Buffer.byteLength(a.part.text, "utf8"));

    const fractions = [0.25, 0.15, 0.10, 0.05];
    for (const { idx } of textParts) {
      const p = parts[idx] as OpenAITextPart;
      for (const frac of fractions) {
        const target = Math.max(512, Math.floor(p.text.length * frac));
        p.text = p.text.slice(0, Math.floor(target * 0.6)) +
          "\n...[truncated by Custos to fit request size limit]...\n" +
          p.text.slice(-Math.floor(target * 0.4));
        const bytes = measure();
        if (bytes <= maxBytes) return { fits: true, bytes };
        // Stop shrinking this part if it's already small enough that
        // further truncation won't meaningfully help.
        if (p.text.length < 100 * 1024) break;
      }
    }
  }
  return { fits: false, bytes: 0 };
}

/** True when an OpenAI message looks like a provider error that was echoed
 *  back into the conversation history. The claude subprocess receives error
 *  responses and includes them as assistant/user messages in the next
 *  request. Over time these accumulate and waste the request-size budget
 *  without contributing useful context. The pre-filter below strips them
 *  before age-based removal, so a conversation bloated with retry loops
 *  shrinks to useful exchanges first.
 *
 *  Detection patterns (extensible):
 *    - Assistant message whose string content starts with "API Error:"
 *    - Any message whose content (string or text-part) contains "Run failed:"
 *      or "Request too large" — the gateway's own 413 phrasing and the
 *      PM agent's failure reports both use this pattern.
 *
 *  The check is intentionally loose to catch both the claude subprocess's
 *  raw error echo AND the PM agent's structured context summary. A false
 *  positive would remove a legitimate message that happens to contain the
 *  words "API Error" in its text — extremely rare in practice since normal
 *  conversation exchanges don't discuss gateway error messages. */
function isErrorMessage(msg: OpenAIMessage): boolean {
  const text = typeof msg.content === "string" ? msg.content :
    Array.isArray(msg.content) ? msg.content.map((p) => (p as OpenAITextPart).text ?? "").join(" ") :
    "";
  // Assistant messages that directly echo provider errors start with
  // exactly this prefix.
  if (msg.role === "assistant" && text.startsWith("API Error:")) return true;
  // Any role — the PM agent embeds failure reports in user-role session
  // context, and claude may re-echo errors as user messages on retry.
  if (text.includes("Run failed:") || text.includes("API Error:")) return true;
  // Gateway-level 413 the claude subprocess includes verbatim.
  if (text.includes("Request too large")) return true;
  return false;
}

/** Remove the oldest messages (everything after the system prompt) from
 *  an OpenAI request until its serialized body fits `maxBytes`. Keeps the
 *  system prompt at index 0 and the newest messages. Returns a
 *  FitRequestResult when truncation succeeds (stillOverLimit can still be
 *  true if even keeping only the system + one message still exceeds the
 *  limit), or undefined when the request has < 3 messages total (nothing
 *  worth dropping).
 *
 *  PROTECTED MESSAGE: the most recent `role: "user"` message is never a
 *  removal candidate. Agent-style conversations (the dominant case)
 *  produce messages where the only `role: "user"` entry is the initial
 *  prompt at index 1 — every subsequent tool_result becomes `role: "tool"`
 *  in the OpenAI translation. That index-1 user message is the live
 *  instruction for this turn (on an agent's first turn, it's the entire
 *  task -- e.g. Custos's rendered work-item prompt), not "old" history to
 *  discard. Confirmed live: on a project whose system prompt + tool
 *  schemas + hook-injected memory context already sat near the byte cap
 *  before any conversation had accumulated, the age-based loop below used
 *  to remove exactly that index-1 message on turn one, leaving the model
 *  system instructions and generic project memory but zero indication of
 *  what ticket it was even working -- it then explored the codebase
 *  aimlessly for dozens of retries, "succeeding" at individual tool calls
 *  while never seeing its actual task. Age-based removal now skips
 *  whichever index holds the last user-role message and drains every
 *  other non-system message first; only if that alone can't fit the
 *  request do the content-truncation fallbacks below touch it (truncating
 *  its *content*, head/tail preserved, is still far better than deleting
 *  it outright).
 *
 *  ERROR-FIRST PRE-FILTER: Before the age-based loop, the function scans
 *  for messages whose content matches known error patterns (
 *  `isErrorMessage`). These error exchanges are dead weight — they echo
 *  provider failures back into the conversation without adding useful
 *  context. Stripping them first often brings the body under the cap in
 *  one pass, avoiding the age-based loop entirely for conversations
 *  bloated by retry storms.
 *
 *  LOOPING BEHAVIOR: A single 50% pass may not suffice for very large
 *  conversations — even after error stripping, a 131MB session file
 *  reduced by 50% still leaves ~65MB, which exceeds most caps. The old
 *  one-shot approach returned `stillOverLimit: true` after that single
 *  attempt, blocking the request entirely. Now the function keeps
 *  removing 25% of remaining (unprotected) messages per iteration until
 *  the body fits or nothing removable is left, at which point the limit
 *  really can't be satisfied by removal alone (unless the system prompt
 *  alone exceeds the cap, which is an operator config issue). */
export function truncateOldestMessages(req: OpenAIRequest, currentBytes: number, maxBytes: number): FitRequestResult | undefined {
  // Need at least system (0) + 2 more messages to have anything worth
  // trimming. A single turn with only its system prompt, one user, and
  // one assistant response has no "old" material to drop.
  if (req.messages.length < 3) return undefined;

  const clone: OpenAIRequest = JSON.parse(JSON.stringify(req));
  let removedCount = 0;

  // Find the most recent user-role message (if any) and shield it from
  // every removal pass below. Recomputed by object identity after each
  // splice since indices shift as messages are removed.
  let protectedMsg: (typeof clone.messages)[number] | undefined;
  for (let idx = clone.messages.length - 1; idx >= 1; idx--) {
    if (clone.messages[idx].role === "user") {
      protectedMsg = clone.messages[idx];
      break;
    }
  }
  const protectedIdx = (): number => (protectedMsg ? clone.messages.indexOf(protectedMsg) : -1);

  // ERROR-FIRST PASS: Strip known error-pattern messages before the
  // age-based loop. In a conversation saturated with retry errors (e.g.
  // a PM agent that retried 50 times before succeeding), this single
  // pass removes all the dead weight at once — no need to touch healthy
  // exchanges. Check every non-system, non-protected message.
  let i = clone.messages.length - 1;
  while (i >= 1) {
    if (i !== protectedIdx() && isErrorMessage(clone.messages[i])) {
      clone.messages.splice(i, 1);
      removedCount++;
    }
    i--;
  }
  if (removedCount > 0) {
    const finalBytes = serializeRequestBytes(clone);
    if (finalBytes <= maxBytes) {
      return {
        request: clone,
        stripped: 0,
        truncatedMessages: removedCount,
        stillOverLimit: false,
        initialBytes: currentBytes,
        finalBytes,
      };
    }
    // Error pass alone wasn't enough — fall through to age-based removal.
  }

  // AGE-BASED LOOP: remove the oldest ~25% of removable (non-system,
  // non-protected) messages per iteration until the body fits or nothing
  // removable remains.
  for (;;) {
    const removable: number[] = [];
    const pIdx = protectedIdx();
    for (let idx = 1; idx < clone.messages.length; idx++) {
      if (idx !== pIdx) removable.push(idx);
    }
    if (removable.length === 0) break;

    const chunkSize = Math.max(1, Math.floor(removable.length * 0.25));
    const toRemove = new Set(removable.slice(0, chunkSize));
    clone.messages = clone.messages.filter((_, idx) => !toRemove.has(idx));
    removedCount += toRemove.size;

    const finalBytes = serializeRequestBytes(clone);
    if (finalBytes <= maxBytes) {
      return {
        request: clone,
        stripped: 0,
        truncatedMessages: removedCount,
        stillOverLimit: false,
        initialBytes: currentBytes,
        finalBytes,
      };
    }
  }

  // Even with only system + 1 message, still over the cap. The message
  // itself may be enormous (a session-context message containing hundreds
  // of "Run failed" entries can be tens of MB alone). Try truncating
  // the system prompt content first, then the first user message, before
  // giving up.
  //
  // SYSTEM PROMPT TRUNCATION: Cut the system message to ~25% of its
  // original size by taking the first and last portions. The system
  // prompt is the agent instructions — losing the middle is better than
  // a 413.
  if (clone.messages.length >= 1) {
    const result = truncateMessageContent(clone.messages, 0, maxBytes, clone.tools);
    if (result.fits) {
      return {
        request: clone,
        stripped: 0,
        truncatedMessages: removedCount,
        stillOverLimit: false,
        initialBytes: currentBytes,
        finalBytes: result.bytes,
      };
    }
  }

  // FIRST USER MESSAGE TRUNCATION: If still over, truncate the first
  // user/assistant message (index 1) to ~25% of its original size. This
  // is the session context that accumulates "Run failed" entries over
  // time. Truncating it preserves decisions and key info from the head
  // and tail while shedding the bloated middle.
  if (clone.messages.length >= 2) {
    const result = truncateMessageContent(clone.messages, 1, maxBytes, clone.tools);
    if (result.fits) {
      return {
        request: clone,
        stripped: 0,
        truncatedMessages: removedCount,
        stillOverLimit: false,
        initialBytes: currentBytes,
        finalBytes: result.bytes,
      };
    }
  }

  // Even after truncating both system and user message content, still
  // over the cap. Nothing more we can do.
  const finalBytes = serializeRequestBytes(clone);
  return {
    request: clone,
    stripped: 0,
    truncatedMessages: removedCount,
    stillOverLimit: true,
    initialBytes: currentBytes,
    finalBytes,
  };
}
