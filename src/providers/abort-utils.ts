// Shared pure AbortSignal helpers used by both queueing mechanisms
// (GlobalQueue and ThrottledProvider). Each wraps a different provider
// dispatch path but both need the same "what error does this abort
// reason become" logic for their queued-entry abort listeners.

/** Mirrors the reason-extraction a queued-entry's abort listener does,
 *  so a signal that's already aborted by the time it's checked rejects
 *  with the same shape whether caught early (a synchronous pre-check)
 *  or via the listener firing while genuinely waiting in the queue. */
export function abortErrorFromSignal(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  if (typeof reason === "string") return new Error(reason);
  return new Error("aborted");
}
