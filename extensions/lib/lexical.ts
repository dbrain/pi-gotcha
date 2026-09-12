import MiniSearch from "minisearch";
import type { Gotcha } from "./store.ts";

export interface Scored {
  id: string;
  score: number;
}

const FIELD_BOOST = { summary: 3, aliases: 3, paths: 1.5, body: 1 };

function documentOf(gotcha: Gotcha) {
  return {
    id: gotcha.id,
    summary: gotcha.summary,
    aliases: gotcha.aliases.join(" "),
    paths: gotcha.paths.join(" "),
    body: gotcha.body,
  };
}

export function buildIndex(gotchas: Gotcha[]): MiniSearch {
  const index = new MiniSearch({
    idField: "id",
    fields: ["summary", "aliases", "paths", "body"],
    storeFields: ["id"],
  });
  index.addAll(gotchas.map(documentOf));
  return index;
}

export function search(index: MiniSearch, query: string, limit = 20): Scored[] {
  const trimmed = query.trim();
  if (!trimmed) return [];
  return index
    .search(trimmed, { fuzzy: 0.2, prefix: true, boost: FIELD_BOOST, combineWith: "OR" })
    .slice(0, limit)
    .map((result) => ({ id: String(result.id), score: result.score }));
}

export class LexicalIndex {
  private index?: MiniSearch;
  private signature = "";

  refresh(gotchas: Gotcha[], signature: string): void {
    if (this.index && this.signature === signature) return;
    this.index = buildIndex(gotchas);
    this.signature = signature;
  }

  search(query: string, limit = 20): Scored[] {
    if (!this.index) return [];
    return search(this.index, query, limit);
  }
}
