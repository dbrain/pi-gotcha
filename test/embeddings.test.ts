import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { embeddingRuntimeRoots, entryPointIn, LOCAL_PACKAGE, SemanticIndex } from "../extensions/lib/embeddings.ts";
import { GotchaStore } from "../extensions/lib/store.ts";
import { cleanup, SAMPLE, settingsFor, tempRoot } from "./helpers.ts";

const roots: string[] = [];

function fakeTree(manifest: Record<string, unknown>, entryFile = "dist/index.mjs"): string {
  const root = tempRoot();
  roots.push(root);
  const dir = join(root, "node_modules", LOCAL_PACKAGE);
  mkdirSync(join(dir, "dist"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
  if (entryFile) writeFileSync(join(dir, entryFile), "export const pipeline = () => {};\n");
  return root;
}

after(() => roots.forEach(cleanup));

describe("entryPointIn", () => {
  test("finds a plain main entry", () => {
    const root = fakeTree({ main: "dist/index.mjs" });
    assert.equal(entryPointIn(root), join(root, "node_modules", LOCAL_PACKAGE, "dist/index.mjs"));
  });

  test("prefers the import condition of exports", () => {
    const root = fakeTree({ exports: { ".": { require: "dist/cjs.js", import: "dist/index.mjs" } }, main: "dist/cjs.js" });
    assert.match(entryPointIn(root) ?? "", /dist\/index\.mjs$/);
  });

  test("handles nested export conditions", () => {
    const root = fakeTree({ exports: { ".": { node: { import: "dist/index.mjs" } } } });
    assert.match(entryPointIn(root) ?? "", /dist\/index\.mjs$/);
  });

  test("handles a bare string exports value", () => {
    const root = fakeTree({ exports: "dist/index.mjs" });
    assert.match(entryPointIn(root) ?? "", /dist\/index\.mjs$/);
  });

  test("falls back to module when exports names nothing usable", () => {
    const root = fakeTree({ exports: { "./other": "dist/other.js" }, module: "dist/index.mjs" });
    assert.match(entryPointIn(root) ?? "", /dist\/index\.mjs$/);
  });

  test("returns null when the package is absent", () => {
    const root = tempRoot();
    roots.push(root);
    assert.equal(entryPointIn(root), null);
  });

  test("returns null when the manifest points at a missing file", () => {
    const root = fakeTree({ main: "dist/gone.mjs" }, "dist/index.mjs");
    assert.equal(entryPointIn(root), null);
  });

  test("returns null on a corrupt manifest", () => {
    const root = tempRoot();
    roots.push(root);
    const dir = join(root, "node_modules", LOCAL_PACKAGE);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), "{ not json");
    assert.equal(entryPointIn(root), null);
  });
});

describe("embeddingRuntimeRoots", () => {
  test("looks in pi's npm tree before the agent directory itself", () => {
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = "/tmp/agent-dir";
    try {
      const roots = embeddingRuntimeRoots();
      assert.equal(roots[0], join("/tmp/agent-dir", "npm"));
      assert.equal(roots[1], "/tmp/agent-dir");
      // The default location is always searched too, so an override does not hide a normal install.
      assert.ok(roots.some((root) => root.includes(join(".pi", "agent"))));
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
    }
  });
});

describe("SemanticIndex.refresh persistence", () => {
  /* A local endpoint that answers the remote embedder's protocol, so the refresh tests exercise
     the real code path without a model or the network. */
  async function fakeEmbedServer(): Promise<{ endpoint: string; close: () => Promise<void> }> {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const { input } = JSON.parse(body) as { input: string[] };
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ data: input.map((text, i) => ({ embedding: [i + 1, text.length] })) }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    return {
      endpoint: `http://127.0.0.1:${port}`,
      close: () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    };
  }

  async function warmStore(): Promise<{
    store: GotchaStore;
    index: SemanticIndex;
    cachePath: string;
    id: string;
    hash: string;
    close: () => Promise<void>;
  }> {
    const { endpoint, close } = await fakeEmbedServer();
    const root = tempRoot();
    roots.push(root);
    const store = new GotchaStore(root);
    const added = store.add(SAMPLE);
    const index = new SemanticIndex(
      store,
      settingsFor({ embeddings: { provider: "remote", endpoint, model: "test" } }),
    );
    await index.refresh(store.list());
    return {
      store,
      index,
      cachePath: join(store.ensureCacheDir(), "embeddings.json"),
      id: added.id,
      hash: added.hash,
      close,
    };
  }

  test("a deletion-only refresh rewrites the cache", async () => {
    const ctx = await warmStore();
    try {
      const before = JSON.parse(readFileSync(ctx.cachePath, "utf8")) as { vectors: Record<string, number[]> };
      assert.ok(before.vectors[ctx.hash], "the warm refresh cached the vector");

      ctx.store.retire(ctx.id);
      await ctx.index.refresh(ctx.store.list());

      const after = JSON.parse(readFileSync(ctx.cachePath, "utf8")) as { vectors: Record<string, number[]> };
      assert.equal(after.vectors[ctx.hash], undefined, "the retired gotcha's vector is gone from disk");
      assert.equal(Object.keys(after.vectors).length, 0);
    } finally {
      await ctx.close();
    }
  });

  test("a refresh with no changes does not rewrite the cache", async () => {
    const ctx = await warmStore();
    try {
      const first = statSync(ctx.cachePath).mtimeMs;
      await ctx.index.refresh(ctx.store.list());
      assert.equal(statSync(ctx.cachePath).mtimeMs, first);
    } finally {
      await ctx.close();
    }
  });

  test("an empty store with nothing cached never resolves the embedder", async () => {
    const root = tempRoot();
    roots.push(root);
    const store = new GotchaStore(root);
    // Provider 'local' would have to load a model; the guard must skip that for an empty store.
    const index = new SemanticIndex(store, settingsFor({ embeddings: { provider: "local" } }));
    await index.refresh(store.list());
    assert.equal(index.ready, false);
    assert.equal(index.failure, undefined);
  });
});
