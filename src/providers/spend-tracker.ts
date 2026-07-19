import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export interface PricingConfig {
  inputPerMillion: number;
  outputPerMillion: number;
}

export interface BudgetConfig {
  limitUsd: number;
  periodDays: number;
}

interface SpendRecord {
  periodStart: number;
  spentUsd: number;
}

const SPEND_PATH = process.env.GATEWAY_SPEND_PATH ?? "data/spend.json";
const DEFAULT_PERIOD_DAYS = 30;

/**
 * Tracks cumulative $ spend per named provider instance so the router can
 * fall through to the next priority entry once a configured budget is
 * exhausted for its current period -- the same idea as the existing
 * rate-limit cooldown, just triggered by cumulative cost instead of a 429.
 * Fixed-window reset (not a true rolling window): once periodDays elapses
 * since the window started, the next request resets the counter rather
 * than decaying old spend continuously. Simpler, close enough for a
 * self-hosted spend cap.
 */
export class SpendTracker {
  private ledger: Record<string, SpendRecord> = {};
  private loaded = false;

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      this.ledger = JSON.parse(await readFile(SPEND_PATH, "utf8"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  private async save(): Promise<void> {
    await mkdir(dirname(SPEND_PATH), { recursive: true });
    await writeFile(SPEND_PATH, JSON.stringify(this.ledger, null, 2), "utf8");
  }

  private periodMs(budget: BudgetConfig | undefined): number {
    return (budget?.periodDays ?? DEFAULT_PERIOD_DAYS) * 24 * 60 * 60 * 1000;
  }

  async isWithinBudget(instanceName: string, budget: BudgetConfig | undefined): Promise<boolean> {
    if (!budget) return true;
    await this.ensureLoaded();
    const record = this.ledger[instanceName];
    if (!record) return true;
    if (Date.now() - record.periodStart > this.periodMs(budget)) return true; // period rolled over
    return record.spentUsd < budget.limitUsd;
  }

  async getSpend(instanceName: string, budget: BudgetConfig | undefined): Promise<{ spentUsd: number; periodStart: number } | null> {
    await this.ensureLoaded();
    const record = this.ledger[instanceName];
    if (!record) return null;
    if (Date.now() - record.periodStart > this.periodMs(budget)) return null; // expired period reads as fresh
    return record;
  }

  async record(
    instanceName: string,
    pricing: PricingConfig | undefined,
    usage: { input_tokens: number; output_tokens: number },
    budget: BudgetConfig | undefined,
  ): Promise<void> {
    if (!pricing) return;
    await this.ensureLoaded();

    const cost = (usage.input_tokens / 1_000_000) * pricing.inputPerMillion + (usage.output_tokens / 1_000_000) * pricing.outputPerMillion;
    const now = Date.now();
    const existing = this.ledger[instanceName];

    if (!existing || now - existing.periodStart > this.periodMs(budget)) {
      this.ledger[instanceName] = { periodStart: now, spentUsd: cost };
    } else {
      existing.spentUsd += cost;
    }

    await this.save();
  }
}
