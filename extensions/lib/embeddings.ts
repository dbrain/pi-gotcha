import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Scored } from "./lexical.ts";
import type { Settings } from "./settings.ts";
import type { Gotcha, GotchaStore } from "./store.ts";

export interface Embedder {
  id: string;
  embed(texts: string[]): Promise<number[][]>;
}

export const LOCAL_PACKAGE = "@huggingface/transformers";

export function embeddingText(gotcha: Gotcha): string {
  return [gotcha.summary, gotcha.aliases.join(", ")].filter(Boolean).join(". ");
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length && i < b.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export async function localEmbedder(model: string): Promise<Embedder> {
  const { pipeline } = (await import(LOCAL_PACKAGE)) as any;
  const extract = await pipeline("feature-extraction", model, { dtype: "q8" });
  return {
    id: `local:${model}`,
    async embed(texts: string[]): Promise<number[][]> {
      const output = await extract(texts, { pooling: "mean", normalize: true });
      return output.tolist() as number[][];
    },
  };
}

export function remoteEmbedder(endpoint: string, model: string, apiKey?: string): Embedder {
  const url = endpoint.replace(/\/$/, "");
  return {
    id: `remote:${model}`,
    async embed(texts: string[]): Promise<number[][]> {
      const response = await fetch(`${url}/embeddings`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({ model, input: texts }),
      });
      if (!response.ok) throw new Error(`embeddings endpoint returned ${response.status}`);
      const payload = (await response.json()) as { data?: Array<{ embedding: number[] }> };
      if (!payload.data) throw new Error("embeddings endpoint returned no data");
      return payload.data.map((entry) => entry.embedding);
    },
  };
}

export async function resolveEmbedder(settings: Settings): Promise<Embedder | null> {
  const { provider, model, endpoint, apiKey } = settings.embeddings;
  if (provider === "off") return null;
  if (provider === "remote") {
    if (!endpoint) throw new Error("embeddings.provider is 'remote' but embeddings.endpoint is not set");
    return remoteEmbedder(endpoint, model, apiKey);
  }
  if (provider === "local") return localEmbedder(model);
  try {
    return await localEmbedder(model);
  } catch {
    return endpoint ? remoteEmbedder(endpoint, model, apiKey) : null;
  }
}

interface CacheFile {
  embedder: string;
  vectors: Record<string, number[]>;
}

export class SemanticIndex {
  private vectors = new Map<string, number[]>();
  private byId = new Map<string, string>();
  private embedder: Embedder | null = null;
  private cachePath = "";
  private ids: string[] = [];
  private readonly store: GotchaStore;
  private readonly settings: Settings;
  ready = false;
  failure?: string;

  constructor(store: GotchaStore, settings: Settings) {
    this.store = store;
    this.settings = settings;
  }

  private loadCache(): CacheFile | null {
    if (!existsSync(this.cachePath)) return null;
    try {
      const parsed = JSON.parse(readFileSync(this.cachePath, "utf8")) as CacheFile;
      return parsed.embedder && parsed.vectors ? parsed : null;
    } catch {
      return null;
    }
  }

  private saveCache(): void {
    const payload: CacheFile = { embedder: this.embedder?.id ?? "", vectors: {} };
    for (const [hash, vector] of this.vectors) payload.vectors[hash] = vector;
    writeFileSync(this.cachePath, JSON.stringify(payload));
  }

  async refresh(gotchas: Gotcha[]): Promise<void> {
    if (this.settings.embeddings.provider === "off") return;
    try {
      if (!this.embedder) this.embedder = await resolveEmbedder(this.settings);
      if (!this.embedder) return;
      if (!this.cachePath) this.cachePath = join(this.store.ensureCacheDir(), "embeddings.json");

      if (this.vectors.size === 0) {
        const cached = this.loadCache();
        // A different model produces vectors that are not comparable, so the cache is dropped.
        if (cached && cached.embedder === this.embedder.id) {
          for (const [hash, vector] of Object.entries(cached.vectors)) this.vectors.set(hash, vector);
        }
      }

      const missing = gotchas.filter((gotcha) => !this.vectors.has(gotcha.hash));
      if (missing.length) {
        const embedded = await this.embedder.embed(missing.map(embeddingText));
        missing.forEach((gotcha, i) => this.vectors.set(gotcha.hash, embedded[i]));
      }

      const live = new Set(gotchas.map((gotcha) => gotcha.hash));
      for (const hash of [...this.vectors.keys()]) if (!live.has(hash)) this.vectors.delete(hash);

      this.ids = gotchas.map((gotcha) => gotcha.id);
      this.byId = new Map(gotchas.map((gotcha) => [gotcha.id, gotcha.hash]));
      if (missing.length) this.saveCache();
      this.ready = true;
      this.failure = undefined;
    } catch (error) {
      this.ready = false;
      this.failure = error instanceof Error ? error.message : String(error);
    }
  }

  async search(query: string, limit = 20): Promise<Scored[]> {
    if (!this.ready || !this.embedder || !query.trim()) return [];
    try {
      const [vector] = await this.embedder.embed([query]);
      const scored: Scored[] = [];
      for (const id of this.ids) {
        const hash = this.byId.get(id);
        const stored = hash ? this.vectors.get(hash) : undefined;
        if (stored) scored.push({ id, score: cosine(vector, stored) });
      }
      return scored.sort((a, b) => b.score - a.score).slice(0, limit);
    } catch (error) {
      this.failure = error instanceof Error ? error.message : String(error);
      return [];
    }
  }
}
