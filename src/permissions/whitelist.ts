import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export type Decision = "allow" | "deny";

interface WhitelistEntry {
  decision: Decision;
  reason: string;
  learnedAt: string;
}

const WHITELIST_PATH = process.env.GATEWAY_WHITELIST_PATH ?? "data/whitelist.json";

export class Whitelist {
  private entries = new Map<string, WhitelistEntry>();
  private loaded = false;

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = JSON.parse(await readFile(WHITELIST_PATH, "utf8")) as Record<string, WhitelistEntry>;
      this.entries = new Map(Object.entries(raw));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  async get(signature: string): Promise<WhitelistEntry | undefined> {
    await this.ensureLoaded();
    return this.entries.get(signature);
  }

  async set(signature: string, decision: Decision, reason: string): Promise<void> {
    await this.ensureLoaded();
    this.entries.set(signature, { decision, reason, learnedAt: new Date().toISOString() });
    await mkdir(dirname(WHITELIST_PATH), { recursive: true });
    await writeFile(WHITELIST_PATH, JSON.stringify(Object.fromEntries(this.entries), null, 2), "utf8");
  }
}
