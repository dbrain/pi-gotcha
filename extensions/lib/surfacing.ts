import type { Gotcha } from "./store.ts";

export function line(gotcha: Gotcha): string {
  const scope = gotcha.paths.length ? gotcha.paths.join(", ") : "project";
  return `[gotcha] ${scope} — ${gotcha.summary} (id: ${gotcha.id})`;
}

export class Surfacer {
  private staged = new Map<string, string>();
  private seen = new Set<string>();

  stage(gotchas: Gotcha[]): void {
    for (const gotcha of gotchas) {
      if (this.seen.has(gotcha.id) || this.staged.has(gotcha.id)) continue;
      this.staged.set(gotcha.id, line(gotcha));
    }
  }

  // Reading a gotcha through the tool makes surfacing it redundant, so the staged line is dropped.
  withdraw(id: string): void {
    this.staged.delete(id);
    this.seen.add(id);
  }

  pending(): string[] {
    return [...this.staged.values()];
  }

  flush(): string | null {
    if (!this.staged.size) return null;
    const text = [...this.staged.values()].join("\n");
    for (const id of this.staged.keys()) this.seen.add(id);
    this.staged.clear();
    return text;
  }

  // Compaction drops the earlier lines from context, so what was delivered is no longer known.
  resetSeen(): void {
    this.seen.clear();
  }

  seenCount(): number {
    return this.seen.size;
  }
}
