import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { Ledger } from "../extensions/lib/ledger.ts";
import { GotchaStore } from "../extensions/lib/store.ts";
import { cleanup, SAMPLE, tempRoot } from "./helpers.ts";

const roots: string[] = [];
function store(): GotchaStore {
  const root = tempRoot();
  roots.push(root);
  const created = new GotchaStore(root);
  created.add(SAMPLE);
  return created;
}

after(() => roots.forEach(cleanup));

describe("write budget", () => {
  test("starts at zero and counts up", () => {
    const ledger = new Ledger(store());
    assert.equal(ledger.writesToday(), 0);
    ledger.recordWrite();
    ledger.recordWrite();
    assert.equal(ledger.writesToday(), 2);
  });

  test("survives a new Ledger over the same store, which is how subagents share it", () => {
    const shared = store();
    new Ledger(shared).recordWrite();
    assert.equal(new Ledger(shared).writesToday(), 1);
  });

  test("a corrupt ledger costs counters, not the store", () => {
    const shared = store();
    const ledger = new Ledger(shared);
    ledger.recordWrite();
    writeFileSync(join(shared.cacheDir, "ledger.json"), "{ not json");
    assert.equal(new Ledger(shared).writesToday(), 0);
    assert.equal(shared.list().length, 1);
  });
});

describe("usage", () => {
  test("records surfaced and read counts", () => {
    const ledger = new Ledger(store());
    ledger.recordSurfaced(["a", "b"]);
    ledger.recordSurfaced(["a"]);
    ledger.recordRead("a");
    assert.deepEqual({ ...ledger.usage("a"), lastSurfaced: undefined }, { surfaced: 2, read: 1, lastSurfaced: undefined });
    assert.equal(ledger.usage("b").read, 0);
    assert.equal(ledger.usage("never-seen").surfaced, 0);
  });

  test("surfacing nothing writes nothing", () => {
    const ledger = new Ledger(store());
    ledger.recordSurfaced([]);
    assert.deepEqual(ledger.allUsage(), {});
  });

  test("noise is what surfaces repeatedly and is never opened", () => {
    const ledger = new Ledger(store());
    for (let i = 0; i < 6; i += 1) ledger.recordSurfaced(["noisy", "useful"]);
    ledger.recordRead("useful");
    assert.deepEqual(ledger.noise(), [{ id: "noisy", surfaced: 6 }]);
  });

  test("a gotcha below the threshold is not called noise", () => {
    const ledger = new Ledger(store());
    ledger.recordSurfaced(["quiet"]);
    assert.deepEqual(ledger.noise(), []);
  });

  test("forget clears a retired gotcha's counters", () => {
    const ledger = new Ledger(store());
    ledger.recordSurfaced(["gone"]);
    ledger.forget("gone");
    assert.equal(ledger.usage("gone").surfaced, 0);
  });
});

describe("retired log", () => {
  test("appends a line per retirement", () => {
    const shared = store();
    const ledger = new Ledger(shared);
    ledger.recordRetired("old-one", "the code was deleted");
    ledger.recordRetired("other", "wrong\nabout everything");
    const log = readFileSync(join(shared.cacheDir, "retired.log"), "utf8").trim().split("\n");
    assert.equal(log.length, 2);
    assert.match(log[0], /old-one\tthe code was deleted/);
    assert.match(log[1], /other\twrong about everything/);
  });

  test("the cache directory exists for it", () => {
    const shared = store();
    new Ledger(shared).recordWrite();
    assert.ok(existsSync(join(shared.cacheDir, "ledger.json")));
  });
});
