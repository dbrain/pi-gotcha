import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { embeddingRuntimeRoots, entryPointIn, LOCAL_PACKAGE } from "../extensions/lib/embeddings.ts";
import { cleanup, tempRoot } from "./helpers.ts";

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
