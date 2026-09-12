import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { line, scopeOf, Surfacer } from "../extensions/lib/surfacing.ts";
import type { Gotcha } from "../extensions/lib/store.ts";

function gotcha(id: string, paths: string[] = []): Gotcha {
  return {
    id,
    summary: `${id} is surprising`,
    paths,
    aliases: [],
    expected: "",
    actual: "",
    body: "",
    created: "2026-01-01",
    updated: "2026-01-01",
    file: `${id}.md`,
    hash: id,
  };
}

describe("scopeOf", () => {
  test("names a single scope", () => assert.equal(scopeOf(gotcha("a", ["src/billing/"])), "src/billing/"));
  test("counts the rest rather than listing them", () =>
    assert.equal(scopeOf(gotcha("a", ["src/billing/", "src/export/csv.ts", "src/api/"])), "src/billing/ +2"));
  test("pathless reads as project", () => assert.equal(scopeOf(gotcha("a")), "project"));
});

describe("line", () => {
  test("names the covered scope, the summary and the id", () => {
    assert.equal(
      line(gotcha("billing", ["src/billing/"])),
      "[gotcha] src/billing/ — billing is surprising (id: billing)",
    );
  });

  test("a long scope list stays one short line", () => {
    assert.match(line(gotcha("wide", ["a/", "b/", "c/", "d/"])), /^\[gotcha\] a\/ \+3 —/);
  });
});

describe("Surfacer", () => {
  test("flushes staged lines once, reporting what it delivered", () => {
    const surfacer = new Surfacer();
    surfacer.stage([gotcha("a"), gotcha("b")]);
    const flushed = surfacer.flush();
    assert.equal(flushed?.text.split("\n").length, 2);
    assert.deepEqual(flushed?.ids, ["a", "b"]);
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
    assert.equal(surfacer.flush()?.text, "[gotcha] project — a is surprising (id: a)");
  });

  test("withdraw drops a staged line and marks it delivered", () => {
    const surfacer = new Surfacer();
    surfacer.stage([gotcha("a"), gotcha("b")]);
    surfacer.withdraw("a");
    assert.equal(surfacer.flush()?.text, "[gotcha] project — b is surprising (id: b)");
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

  test("seenCount tracks what this session has been told", () => {
    const surfacer = new Surfacer();
    surfacer.stage([gotcha("a"), gotcha("b")]);
    surfacer.flush();
    assert.equal(surfacer.seenCount(), 2);
  });
});
