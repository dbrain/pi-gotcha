import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { line, Surfacer } from "../extensions/lib/surfacing.ts";
import type { Gotcha } from "../extensions/lib/store.ts";

function gotcha(id: string, paths: string[] = []): Gotcha {
  return {
    id,
    summary: `${id} is surprising`,
    paths,
    aliases: [],
    evidence: "",
    body: "",
    created: "2026-01-01",
    updated: "2026-01-01",
    file: `${id}.md`,
    hash: id,
  };
}

describe("line", () => {
  test("names the covered scope", () => {
    assert.equal(line(gotcha("billing", ["src/billing/"])), "[gotcha] src/billing/ — billing is surprising (id: billing)");
  });

  test("pathless gotchas read as project scope", () => {
    assert.match(line(gotcha("wide")), /^\[gotcha\] project —/);
  });
});

describe("Surfacer", () => {
  test("flushes staged lines once", () => {
    const surfacer = new Surfacer();
    surfacer.stage([gotcha("a"), gotcha("b")]);
    const text = surfacer.flush();
    assert.equal(text?.split("\n").length, 2);
    assert.equal(surfacer.flush(), null);
  });

  test("a gotcha already delivered is not staged again", () => {
    const surfacer = new Surfacer();
    surfacer.stage([gotcha("a")]);
    surfacer.flush();
    surfacer.stage([gotcha("a")]);
    assert.equal(surfacer.flush(), null);
  });

  test("staging the same gotcha twice in one turn yields one line", () => {
    const surfacer = new Surfacer();
    surfacer.stage([gotcha("a")]);
    surfacer.stage([gotcha("a")]);
    assert.equal(surfacer.flush(), "[gotcha] project — a is surprising (id: a)");
  });

  test("withdraw drops a staged line and marks it delivered", () => {
    const surfacer = new Surfacer();
    surfacer.stage([gotcha("a"), gotcha("b")]);
    surfacer.withdraw("a");
    assert.equal(surfacer.flush(), "[gotcha] project — b is surprising (id: b)");
    surfacer.stage([gotcha("a")]);
    assert.equal(surfacer.flush(), null);
  });

  test("compaction lets delivered gotchas surface again", () => {
    const surfacer = new Surfacer();
    surfacer.stage([gotcha("a")]);
    surfacer.flush();
    surfacer.resetSeen();
    surfacer.stage([gotcha("a")]);
    assert.ok(surfacer.flush());
  });

  test("nothing staged means nothing delivered", () => {
    assert.equal(new Surfacer().flush(), null);
  });
});
