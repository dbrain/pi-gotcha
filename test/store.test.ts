import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { GotchaStore, slugify } from "../extensions/lib/store.ts";
import { cleanup, SAMPLE, tempRoot } from "./helpers.ts";

const roots: string[] = [];
function root(): string {
  const dir = tempRoot();
  roots.push(dir);
  return dir;
}

after(() => roots.forEach(cleanup));

describe("slugify", () => {
  const cases: Array<[string, string]> = [
    ["Invoice totals are integer cents and the parser drops commas", "invoice-totals-are-integer-cents-and"],
    ["  Weird   ---  punctuation!!  ", "weird-punctuation"],
    ["!!!", "gotcha"],
    ["CamelCase Words", "camelcase-words"],
  ];
  for (const [input, expected] of cases) {
    test(JSON.stringify(input), () => assert.equal(slugify(input), expected));
  }
});

describe("store", () => {
  test("round-trips every field", () => {
    const store = new GotchaStore(root());
    const written = store.add(SAMPLE);
    const read = store.get(written.id);
    assert.ok(read);
    assert.equal(read.summary, SAMPLE.summary);
    assert.deepEqual(read.paths, SAMPLE.paths);
    assert.deepEqual(read.aliases, SAMPLE.aliases);
    assert.equal(read.expected, SAMPLE.expected);
    assert.equal(read.actual, SAMPLE.actual);
    assert.equal(read.body, SAMPLE.body);
    assert.match(read.created, /^\d{4}-\d{2}-\d{2}$/);
  });

  test("a summary with colons and quotes survives the round trip", () => {
    const store = new GotchaStore(root());
    const summary = 'Header "X-Trace: id" must match config: otherwise the gateway drops it';
    const written = store.add({
      summary,
      expected: "The gateway to forward the header untouched",
      actual: "Requests vanished with no log line at all",
    });
    assert.equal(store.get(written.id)?.summary, summary);
  });

  test("ids do not collide", () => {
    const store = new GotchaStore(root());
    const a = store.add(SAMPLE);
    const b = store.add(SAMPLE);
    assert.notEqual(a.id, b.id);
    assert.equal(store.list().length, 2);
  });

  test("update changes fields and stamps updated, keeping created", () => {
    const store = new GotchaStore(root());
    const written = store.add(SAMPLE);
    const updated = store.update(written.id, { summary: "New summary", aliases: ["x"] });
    assert.equal(updated?.summary, "New summary");
    assert.deepEqual(updated?.aliases, ["x"]);
    assert.equal(updated?.created, written.created);
    assert.equal(updated?.expected, SAMPLE.expected);
  });

  test("update of a missing id returns undefined", () => {
    assert.equal(new GotchaStore(root()).update("nope", { summary: "x" }), undefined);
  });

  test("retire deletes the file", () => {
    const store = new GotchaStore(root());
    const written = store.add(SAMPLE);
    assert.equal(store.retire(written.id), true);
    assert.equal(store.retire(written.id), false);
    assert.equal(store.list().length, 0);
  });

  test("the cache directory is gitignored", () => {
    const dir = root();
    const store = new GotchaStore(dir);
    store.add(SAMPLE);
    const ignore = join(store.dir, ".gitignore");
    assert.ok(existsSync(ignore));
    assert.match(readFileSync(ignore, "utf8"), /\.cache\//);
  });

  test("a proposal is held apart from the store until accepted", () => {
    const store = new GotchaStore(root());
    const proposed = store.propose(SAMPLE);
    assert.equal(store.list().length, 0);
    assert.equal(store.proposals().length, 1);
    assert.equal(store.get(proposed.id), undefined);
    assert.equal(store.getProposal(proposed.id)?.summary, SAMPLE.summary);
  });

  test("accepting a proposal moves it into the store", () => {
    const store = new GotchaStore(root());
    const proposed = store.propose(SAMPLE);
    const accepted = store.acceptProposal(proposed.id);
    assert.equal(accepted?.id, proposed.id);
    assert.equal(store.list().length, 1);
    assert.equal(store.proposals().length, 0);
  });

  test("rejecting a proposal deletes it", () => {
    const store = new GotchaStore(root());
    const proposed = store.propose(SAMPLE);
    assert.equal(store.rejectProposal(proposed.id), true);
    assert.equal(store.rejectProposal(proposed.id), false);
    assert.equal(store.proposals().length, 0);
  });

  test("a proposal id never collides with a recorded one", () => {
    const store = new GotchaStore(root());
    const recorded = store.add(SAMPLE);
    const proposed = store.propose(SAMPLE);
    assert.notEqual(recorded.id, proposed.id);
    store.acceptProposal(proposed.id);
    assert.equal(store.list().length, 2);
  });

  test("hash tracks content, signature tracks the store", () => {
    const store = new GotchaStore(root());
    const written = store.add(SAMPLE);
    const before = store.signature();
    store.update(written.id, { body: "changed" });
    assert.notEqual(store.get(written.id)?.hash, written.hash);
    assert.notEqual(store.signature(), before);
  });

  test("malformed files are skipped, not fatal", () => {
    const dir = root();
    const store = new GotchaStore(dir);
    store.add(SAMPLE);
    writeFileSync(join(store.dir, "broken.md"), "no front matter here");
    writeFileSync(join(store.dir, "empty-summary.md"), "---\nsummary: \n---\nbody");
    assert.equal(store.list().length, 1);
  });
});
