import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GotchaStore } from "./store.ts";

export interface Usage {
  surfaced: number;
  read: number;
  lastSurfaced?: string;
}

interface LedgerFile {
  writes: Record<string, number>;
  allowance: Record<string, number>;
  overrides: Record<string, number>;
  usage: Record<string, Usage>;
}

const KEEP_DAYS = 30;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/* Write budget and usage counts live beside the store rather than in memory: the cap has to
   hold across sessions and across the separate processes that background subagents run in,
   where an in-memory counter would give every child its own allowance. */
export class Ledger {
  private readonly store: GotchaStore;
  private cache?: LedgerFile;

  constructor(store: GotchaStore) {
    this.store = store;
  }

  private path(): string {
    return join(this.store.ensureCacheDir(), "ledger.json");
  }

  private load(): LedgerFile {
    if (this.cache) return this.cache;
    const path = this.path();
    if (existsSync(path)) {
      try {
        const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<LedgerFile>;
        this.cache = {
          writes: parsed.writes ?? {},
          allowance: parsed.allowance ?? {},
          overrides: parsed.overrides ?? {},
          usage: parsed.usage ?? {},
        };
        return this.cache;
      } catch {
        /* a corrupt ledger costs counters, never the store */
      }
    }
    this.cache = { writes: {}, allowance: {}, overrides: {}, usage: {} };
    return this.cache;
  }

  private save(data: LedgerFile): void {
    const cutoff = new Date(Date.now() - KEEP_DAYS * 86_400_000).toISOString().slice(0, 10);
    for (const day of Object.keys(data.writes)) if (day < cutoff) delete data.writes[day];
    for (const day of Object.keys(data.allowance)) if (day < cutoff) delete data.allowance[day];
    for (const day of Object.keys(data.overrides)) if (day < cutoff) delete data.overrides[day];
    this.cache = data;
    writeFileSync(this.path(), JSON.stringify(data));
  }

  writesToday(): number {
    return this.load().writes[today()] ?? 0;
  }

  recordWrite(): void {
    const data = this.load();
    data.writes[today()] = (data.writes[today()] ?? 0) + 1;
    this.save(data);
  }

  // A day of deep work can genuinely produce more findings than the standing budget, so the
  // budget is raisable for that day rather than something to argue with on every write.
  capToday(fallback: number): number {
    return this.load().allowance[today()] ?? fallback;
  }

  raiseToday(cap: number): void {
    const data = this.load();
    data.allowance[today()] = cap;
    this.save(data);
  }

  recordOverride(): void {
    const data = this.load();
    data.overrides[today()] = (data.overrides[today()] ?? 0) + 1;
    this.save(data);
  }

  overridesToday(): number {
    return this.load().overrides[today()] ?? 0;
  }

  usage(id: string): Usage {
    return this.load().usage[id] ?? { surfaced: 0, read: 0 };
  }

  allUsage(): Record<string, Usage> {
    return this.load().usage;
  }

  recordSurfaced(ids: string[]): void {
    if (!ids.length) return;
    const data = this.load();
    for (const id of ids) {
      const entry = data.usage[id] ?? { surfaced: 0, read: 0 };
      entry.surfaced += 1;
      entry.lastSurfaced = today();
      data.usage[id] = entry;
    }
    this.save(data);
  }

  recordRead(id: string): void {
    const data = this.load();
    const entry = data.usage[id] ?? { surfaced: 0, read: 0 };
    entry.read += 1;
    data.usage[id] = entry;
    this.save(data);
  }

  forget(id: string): void {
    const data = this.load();
    delete data.usage[id];
    this.save(data);
  }

  recordRetired(id: string, reason: string): void {
    const line = `${new Date().toISOString()}\t${id}\t${reason.replace(/\s+/g, " ")}\n`;
    appendFileSync(join(this.store.ensureCacheDir(), "retired.log"), line);
  }

  // Surfaced repeatedly and never opened is the signature of a gotcha nobody needs.
  noise(minSurfaced = 5): Array<{ id: string; surfaced: number }> {
    const data = this.load();
    return Object.entries(data.usage)
      .filter(([, entry]) => entry.surfaced >= minSurfaced && entry.read === 0)
      .map(([id, entry]) => ({ id, surfaced: entry.surfaced }))
      .sort((a, b) => b.surfaced - a.surfaced);
  }
}
