import { debugLog } from "./debug.ts";
import type { Gotcha } from "./store.ts";

export function scopeOf(gotcha: Gotcha): string {
  if (!gotcha.paths.length) return "project";
  const [first, ...rest] = gotcha.paths;
  return rest.length ? `${first} +${rest.length}` : first;
}

export function line(gotcha: Gotcha): string {
  return `[gotcha] ${scopeOf(gotcha)} — ${gotcha.summary} (id: ${gotcha.id})`;
}

export interface Flushed {
  text: string;
  ids: string[];
}

// What the staging site knows about its own store, for the PI_GOTCHA_DEBUG log.
export interface SurfacerContext {
  root: string;
  signature: string;
}

export class Surfacer {
  private staged = new Map<string, string>();
  private seen = new Set<string>();
  private readonly context?: () => SurfacerContext;

  constructor(context?: () => SurfacerContext) {
    this.context = context;
  }

  stage(gotchas: Gotcha[]): void {
    const added: Gotcha[] = [];
    for (const gotcha of gotchas) {
      if (this.seen.has(gotcha.id) || this.staged.has(gotcha.id)) continue;
      this.staged.set(gotcha.id, line(gotcha));
      added.push(gotcha);
    }
    if (added.length) {
      const { root, signature } = this.context?.() ?? {};
      debugLog("stage", {
        root,
        signature,
        staged: added.map((gotcha) => ({ id: gotcha.id, summary: gotcha.summary.slice(0, 30) })),
      });
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

  /* Between staging and delivery the store can change: a gotcha may be retired, or its summary
     corrected. The staged line is a snapshot, so delivery re-checks the store and re-renders
     from the current object: a line for a gone gotcha is dropped, a line for a changed one says
     what is true now. Without a lookup (tests, older callers) the staged text is delivered as
     it was staged. */
  flush(lookup?: (id: string) => Gotcha | undefined): Flushed | null {
    if (!this.staged.size) return null;
    const lines: string[] = [];
    const ids: string[] = [];
    const dropped: string[] = [];
    for (const [id, text] of this.staged) {
      const current = lookup?.(id);
      if (lookup && !current) {
        // Gone before delivery: the staged line is a snapshot of a deleted fact. Drop it, and
        // mark it seen so a re-added id does not re-surface the same line in this session.
        this.seen.add(id);
        dropped.push(id);
        continue;
      }
      lines.push(current ? line(current) : text);
      ids.push(id);
    }
    this.staged.clear();
    if (!ids.length) {
      // The staged snapshot pointed at facts that no longer exist: that is exactly the
      // 2026-09-13 incident shape, so the drop itself is worth the log line.
      if (dropped.length) {
        const { root, signature } = this.context?.() ?? {};
        debugLog("flush", { root, signature, delivered: [], dropped, text: "" });
      }
      return null;
    }
    for (const id of ids) this.seen.add(id);
    const { root, signature } = this.context?.() ?? {};
    debugLog("flush", { root, signature, delivered: ids, dropped, text: lines.join("\n") });
    return { text: lines.join("\n"), ids };
  }

  // Compaction drops the earlier lines from context, so what was delivered is no longer known.
  resetSeen(): void {
    this.seen.clear();
  }

  seenCount(): number {
    return this.seen.size;
  }
}
