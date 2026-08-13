// Small pure helper used by ThrottledProvider's slot-acquisition path.

/** Combine a caller's abort signal with the throttle's own internal
 *  controller signal, so `abortAll()` can abort in-flight calls the
 *  caller never asked to abort, while a caller-initiated abort still
 *  propagates through normally. */
export function combineSignals(primary: AbortSignal | undefined, fallback: AbortSignal): AbortSignal {
  if (!primary) return fallback;
  // If primary is already aborted, the combined signal should be too.
  // AbortSignal listeners do NOT replay retroactively, so any listener
  // we'd attach below would silently never fire -- the caller has to
  // observe the signal as already aborted.
  if (primary.aborted) {
    return primary;
  }
  // Same retroactive-listener trap applies symmetrically to fallback:
  // abortAll() can synchronously abort an internalController pushed
  // for a queued entry BEFORE runWithSlotAsync resumes and reaches
  // this function. Without the early-return, the listener we'd attach
  // would silently never fire, leaving the inner Promise pending.
  if (fallback.aborted) {
    return fallback;
  }
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  primary.addEventListener("abort", onAbort, { once: true });
  fallback.addEventListener("abort", onAbort, { once: true });
  controller.signal.addEventListener("abort", () => {
    primary.removeEventListener("abort", onAbort);
    fallback.removeEventListener("abort", onAbort);
  }, { once: true });
  return controller.signal;
}
