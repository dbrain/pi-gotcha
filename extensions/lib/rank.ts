import type { Scored } from "./lexical.ts";

export interface Ranked {
  id: string;
  score: number;
  lexical?: number;
  semantic?: number;
}

const RRF_K = 60;

// Reciprocal rank fusion: the two channels' scores are not on a common scale (BM25 is
// unbounded and query-dependent, cosine is bounded), so ranks are fused, not scores.
export function fuse(lists: Scored[][], limit = 20): Ranked[] {
  const merged = new Map<string, Ranked>();
  const channels: Array<keyof Pick<Ranked, "lexical" | "semantic">> = ["lexical", "semantic"];
  lists.forEach((list, channelIndex) => {
    const channel = channels[channelIndex];
    list.forEach((entry, rank) => {
      const current = merged.get(entry.id) ?? { id: entry.id, score: 0 };
      current.score += 1 / (RRF_K + rank + 1);
      if (channel) current[channel] = entry.score;
      merged.set(entry.id, current);
    });
  });
  return [...merged.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

export const SEMANTIC_CONFIDENT = 0.45;
export const LEXICAL_RELATIVE = 0.35;

/* Search always returns its best guesses, however bad, so a query the store cannot answer
   still comes back with three confident-looking results.

   Cosine is the only channel that can say "nothing here is about this", but filtering on it
   alone throws away results keyword search answers perfectly — a query naming a file, or
   phrased as the task in hand. Measured over the fixture corpus (npm run floors): cosine
   alone buys silence at 0.25 and costs 8 of 40 recall, while keeping what either channel is
   confident about and using cosine only to veto the plainly unrelated holds 30 of 40 with
   every unanswerable query silenced. Hence two tests rather than one.

   Without embeddings there is no veto available, so a weak query still gets the best keyword
   guesses: a known limit, not an oversight. */
export function prune(ranked: Ranked[], veto: number): Ranked[] {
  if (!ranked.length) return ranked;
  const best = Math.max(...ranked.map((entry) => entry.lexical ?? 0), 0);
  const strongLexical = (entry: Ranked) => best > 0 && (entry.lexical ?? 0) >= best * LEXICAL_RELATIVE;

  if (!ranked.some((entry) => entry.semantic !== undefined)) {
    return best > 0 ? ranked.filter(strongLexical) : [];
  }
  return ranked.filter(
    (entry) => (entry.semantic ?? 0) >= veto && ((entry.semantic ?? 0) >= SEMANTIC_CONFIDENT || strongLexical(entry)),
  );
}

export interface GateOptions {
  standout: number;
  semanticFloor: number;
  cap: number;
}

export interface GateResult {
  surfaced: Ranked[];
  reason: "lexical-standout" | "semantic-floor" | "below-threshold" | "empty";
}

/* Two different tests, because the two scores mean different things.

   A BM25 score is a fraction of the query's own term mass, so it falls as the query gets
   longer and cannot be compared against a constant. What is stable is how far the best
   result stands out from the best one that would not have been surfaced anyway.

   Cosine over normalized vectors is bounded and comparable across queries, so an absolute
   floor is meaningful and catches the case the ratio misses: several genuinely relevant
   results that therefore do not stand out from each other. */
export function gate(ranked: Ranked[], options: GateOptions): GateResult {
  if (!ranked.length) return { surfaced: [], reason: "empty" };
  const top = ranked[0];
  const rival = ranked[options.cap];

  const lexicalTop = top.lexical ?? 0;
  const lexicalRival = rival?.lexical ?? 0;
  const standsOut = lexicalTop > 0 && (lexicalRival === 0 || lexicalTop / lexicalRival >= options.standout);
  if (standsOut) return { surfaced: ranked.slice(0, options.cap), reason: "lexical-standout" };

  if ((top.semantic ?? 0) >= options.semanticFloor) {
    const surfaced = ranked.slice(0, options.cap).filter((entry) => (entry.semantic ?? 0) >= options.semanticFloor);
    return { surfaced, reason: "semantic-floor" };
  }

  return { surfaced: [], reason: "below-threshold" };
}
