import { SemanticIndex } from "./embeddings.ts";
import { Ledger } from "./ledger.ts";
import { LexicalIndex, type Scored } from "./lexical.ts";
import { fuse, prune, type Ranked } from "./rank.ts";
import { loadSettings, userConfigDir, type Settings } from "./settings.ts";
import { GotchaStore, type Gotcha } from "./store.ts";
import { Surfacer } from "./surfacing.ts";

export interface Runtime {
  root: string;
  store: GotchaStore;
  userStore: GotchaStore;
  settings: Settings;
  lexical: LexicalIndex;
  semantic: SemanticIndex;
  userLexical: LexicalIndex;
  userSemantic: SemanticIndex;
  surfacer: Surfacer;
  ledger: Ledger;
  userLedger: Ledger;
}

// The user store is the home for cross-project knowledge. It is deliberately a separate store
// rather than a flag on individual gotchas: the surfacing paths read the project store only, so
// user-level gotchas can never be auto-injected, no matter what paths they carry.
export function createUserStore(): GotchaStore {
  return new GotchaStore(userConfigDir(), "gotchas");
}

export function createRuntime(root: string, settings = loadSettings(root), userStore = createUserStore()): Runtime {
  const store = new GotchaStore(root);
  return {
    root,
    store,
    userStore,
    settings,
    lexical: new LexicalIndex(),
    semantic: new SemanticIndex(store, settings),
    userLexical: new LexicalIndex(),
    userSemantic: new SemanticIndex(userStore, settings),
    surfacer: new Surfacer(() => ({ root, signature: store.signature() })),
    ledger: new Ledger(store),
    userLedger: new Ledger(userStore),
  };
}

export function gotchas(runtime: Runtime): Gotcha[] {
  const all = runtime.store.list();
  runtime.lexical.refresh(all, runtime.store.signature());
  return all;
}

export function userGotchas(runtime: Runtime): Gotcha[] {
  const all = runtime.userStore.list();
  runtime.userLexical.refresh(all, runtime.userStore.signature());
  return all;
}

export function refreshSemantic(runtime: Runtime): Promise<void> {
  return Promise.all([
    runtime.semantic.refresh(runtime.store.list()),
    runtime.userSemantic.refresh(runtime.userStore.list()),
  ]).then(() => undefined);
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
  void runtime.semantic.refresh(runtime.store.list()).finally(() => warming.delete(runtime));
}

const userWarming = new WeakSet<Runtime>();

function warmUser(runtime: Runtime): void {
  if (runtime.settings.embeddings.provider === "off") return;
  if (runtime.userSemantic.ready || userWarming.has(runtime)) return;
  userWarming.add(runtime);
  void runtime.userSemantic.refresh(runtime.userStore.list()).finally(() => userWarming.delete(runtime));
}

export async function hybridSearch(runtime: Runtime, query: string, limit = 10): Promise<Ranked[]> {
  const all = gotchas(runtime);
  if (!all.length || !query.trim()) return [];
  warm(runtime);
  const lexical: Scored[] = runtime.lexical.search(query, limit * 2);
  const semantic: Scored[] = await runtime.semantic.search(query, limit * 2);
  return fuse([lexical, semantic], limit);
}

export async function hybridUserSearch(runtime: Runtime, query: string, limit = 10): Promise<Ranked[]> {
  const all = userGotchas(runtime);
  if (!all.length || !query.trim()) return [];
  warmUser(runtime);
  const lexical: Scored[] = runtime.userLexical.search(query, limit * 2);
  const semantic: Scored[] = await runtime.userSemantic.search(query, limit * 2);
  return fuse([lexical, semantic], limit);
}

/* Explicit search reaches both stores. Each store is pruned on its own channels — the veto and
   the relative-lexical test are meaningful within one store, and a store whose semantic index
   is not warm yet falls back to keyword results on its own. RRF scores are rank-based, so the
   surviving entries are comparable across stores and merge by the same score. */
export async function searchAll(runtime: Runtime, query: string, limit = 10): Promise<Ranked[]> {
  const [project, user] = await Promise.all([
    hybridSearch(runtime, query, limit),
    hybridUserSearch(runtime, query, limit),
  ]);
  return [...prune(project, runtime.settings.searchVeto), ...prune(user, runtime.settings.searchVeto)]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export function byId(all: Gotcha[]): Map<string, Gotcha> {
  return new Map(all.map((gotcha) => [gotcha.id, gotcha]));
}
