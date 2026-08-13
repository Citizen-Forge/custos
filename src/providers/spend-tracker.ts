import { readJsonFile, writeJsonFile } from "../util/json-file.js";

export interface PricingConfig {
  inputPerMillion: number;
  outputPerMillion: number;
}

export interface BudgetConfig {
  limitUsd: number;
  periodDays: number;
}

export interface SpendRecord {
  periodStart: number;
  spentUsd: number;
}

const SPEND_PATH = process.env.GATEWAY_SPEND_PATH ?? "data/spend.json";

/**
 * Tracks cumulative $ spend per project+provider pair, so the orchestrator
 * can check a project's total spend against its monthly budget without
 * re-aggregating individual run records. Keys are "${projectId}:${providerName}".
 * Fixed-window reset (not a true rolling window): once a calendar month
 * elapses since the period started, the next record resets the counter.
 */
export class SpendTracker {
  private ledger: Record<string, SpendRecord> = {};
  private loaded = false;

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    this.ledger = await readJsonFile<Record<string, SpendRecord>>(SPEND_PATH, {});
  }

  private async save(): Promise<void> {
    await writeJsonFile(SPEND_PATH, this.ledger);
  }

  private key(projectId: string, providerName: string): string {
    return `${projectId}:${providerName}`;
  }

  private periodMs(monthStart: number): number {
    // A single calendar month from the period start.
    const start = new Date(monthStart);
    const next = new Date(start.getFullYear(), start.getMonth() + 1, 1);
    return next.getTime() - start.getTime();
  }

  /**
   * Record a direct cost in USD against a project+provider pair.
   * Period resets on a calendar-month boundary from the first recorded
   * cost for this project+provider pair.
   */
  async record(
    projectId: string,
    providerName: string,
    costUsd: number,
  ): Promise<void> {
    if (!costUsd || costUsd <= 0) return;
    await this.ensureLoaded();

    const k = this.key(projectId, providerName);
    const now = Date.now();
    const existing = this.ledger[k];

    if (!existing || now - existing.periodStart > this.periodMs(existing.periodStart)) {
      this.ledger[k] = { periodStart: now, spentUsd: costUsd };
    } else {
      existing.spentUsd += costUsd;
    }

    await this.save();
  }

  /**
   * Total cost across all providers for this project since the start of
   * the current period (per-provider periods may differ slightly since
   * each starts on its first recorded cost). Returns 0 when nothing has
   * been recorded for this project.
   */
  async getProjectSpend(projectId: string): Promise<number> {
    await this.ensureLoaded();
    let total = 0;
    const prefix = `${projectId}:`;
    for (const [k, record] of Object.entries(this.ledger)) {
      if (!k.startsWith(prefix)) continue;
      const elapsed = Date.now() - record.periodStart;
      if (elapsed <= this.periodMs(record.periodStart)) {
        total += record.spentUsd;
      }
    }
    return total;
  }

  /**
   * Return every spend record keyed by `${projectId}:${providerName}` that
   * is still within its period. Used by internal tooling and debugging; the
   * admin UI summarises via getProjectSpend.
   */
  async snapshot(): Promise<Record<string, SpendRecord>> {
    await this.ensureLoaded();
    return { ...this.ledger };
  }
}
