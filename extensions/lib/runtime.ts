import { SemanticIndex } from "./embeddings.ts";
import { LexicalIndex, type Scored } from "./lexical.ts";
import { fuse, type Ranked } from "./rank.ts";
import type { Settings } from "./settings.ts";
import { GotchaStore, type Gotcha } from "./store.ts";
import { Surfacer } from "./surfacing.ts";

export interface SessionState {
  writes: number;
}

export interface Runtime {
  root: string;
  store: GotchaStore;
  settings: Settings;
  lexical: LexicalIndex;
  semantic: SemanticIndex;
  surfacer: Surfacer;
  session: SessionState;
}

export function createRuntime(root: string, settings: Settings): Runtime {
  const store = new GotchaStore(root);
  return {
    root,
    store,
    settings,
    lexical: new LexicalIndex(),
    semantic: new SemanticIndex(store, settings),
    surfacer: new Surfacer(),
    session: { writes: 0 },
  };
}

export function gotchas(runtime: Runtime): Gotcha[] {
  const all = runtime.store.list();
  runtime.lexical.refresh(all, runtime.store.signature());
  return all;
}

export function refreshSemantic(runtime: Runtime): Promise<void> {
  return runtime.semantic.refresh(runtime.store.list());
}

export async function hybridSearch(runtime: Runtime, query: string, limit = 10): Promise<Ranked[]> {
  const all = gotchas(runtime);
  if (!all.length || !query.trim()) return [];
  const lexical: Scored[] = runtime.lexical.search(query, limit * 2);
  const semantic: Scored[] = await runtime.semantic.search(query, limit * 2);
  return fuse([lexical, semantic], limit);
}

export function byId(all: Gotcha[]): Map<string, Gotcha> {
  return new Map(all.map((gotcha) => [gotcha.id, gotcha]));
}
