import type { LlmProvider } from '../config/types.js';

/**
 * Sliding-window RPM throttle.
 * Tracks request timestamps per provider and blocks when the window is full.
 */
export class RpmThrottle {
  private windows = new Map<number, number[]>();

  /** Return the number of ms to wait before the next slot opens, or 0. */
  async waitForSlot(provider: LlmProvider): Promise<void> {
    const id = provider.id ?? 0;
    const limit = provider.rpm_limit;
    const now = Date.now();
    const window = this.windows.get(id) ?? [];

    // Purge timestamps older than 60 s
    const cutoff = now - 60_000;
    const active = window.filter((t) => t > cutoff);
    this.windows.set(id, active);

    if (active.length < limit) {
      active.push(now);
      return;
    }

    // Window is full — wait until the oldest entry expires
    const oldest = active[0]!;
    const waitMs = oldest + 60_000 - now + 100; // +100ms safety margin
    if (waitMs > 0) {
      await new Promise((r) => setTimeout(r, waitMs));
    }
    active.shift();
    active.push(Date.now());
  }
}
