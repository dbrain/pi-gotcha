import { SemanticIndex } from "./embeddings.ts";
import { Ledger } from "./ledger.ts";
import { LexicalIndex, type Scored } from "./lexical.ts";
import { fuse, type Ranked } from "./rank.ts";
import { loadSettings, type Settings } from "./settings.ts";
import { GotchaStore, type Gotcha } from "./store.ts";
import { Surfacer } from "./surfacing.ts";

export interface Runtime {
  root: string;
  store: GotchaStore;
  settings: Settings;
  lexical: LexicalIndex;
  semantic: SemanticIndex;
  surfacer: Surfacer;
  ledger: Ledger;
}

export function createRuntime(root: string, settings = loadSettings(root)): Runtime {
  const store = new GotchaStore(root);
  return {
    root,
    store,
    settings,
    lexical: new LexicalIndex(),
    semantic: new SemanticIndex(store, settings),
    surfacer: new Surfacer(),
    ledger: new Ledger(store),
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

const warming = new WeakSet<Runtime>();

/* The embedding model costs ~100MB resident and seconds of startup in every process that
   loads it, background subagent runners included, so it is loaded on the first query that
   could use it rather than at session start. That query itself runs keyword-only; by the
   next one the index is warm. */
function warm(runtime: Runtime): void {
  if (runtime.settings.embeddings.provider === "off") return;
  if (runtime.semantic.ready || warming.has(runtime)) return;
  warming.add(runtime);
  void refreshSemantic(runtime).finally(() => warming.delete(runtime));
}

export async function hybridSearch(runtime: Runtime, query: string, limit = 10): Promise<Ranked[]> {
  const all = gotchas(runtime);
  if (!all.length || !query.trim()) return [];
  warm(runtime);
  const lexical: Scored[] = runtime.lexical.search(query, limit * 2);
  const semantic: Scored[] = await runtime.semantic.search(query, limit * 2);
  return fuse([lexical, semantic], limit);
}

export function byId(all: Gotcha[]): Map<string, Gotcha> {
  return new Map(all.map((gotcha) => [gotcha.id, gotcha]));
}
