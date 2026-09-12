import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { jaccard, runGotchaTool } from "../extensions/lib/tool.ts";
import { cleanup, runtimeFor, SAMPLE, tempRoot } from "./helpers.ts";

const roots: string[] = [];
function runtime(overrides = {}) {
  const root = tempRoot();
  roots.push(root);
  return runtimeFor(root, overrides);
}

after(() => roots.forEach(cleanup));

const ADD = {
  action: "add",
  summary: SAMPLE.summary,
  evidence: SAMPLE.evidence,
  paths: SAMPLE.paths,
  aliases: SAMPLE.aliases,
  body: SAMPLE.body,
};

describe("jaccard", () => {
  test("identical text scores 1", () => assert.equal(jaccard("alpha beta gamma", "alpha beta gamma"), 1));
  test("disjoint text scores 0", () => assert.equal(jaccard("alpha beta", "gamma delta"), 0));
  test("words of two characters or fewer are ignored", () => assert.equal(jaccard("a an of", "a an of"), 0));
  test("shared wording drives the score", () => assert.ok(jaccard("invoice cents comma", "invoice cents export") > 0.3));
});

describe("add guards", () => {
  test("records a well-formed gotcha", async () => {
    const active = runtime();
    const result = await runGotchaTool(active, ADD);
    assert.match(result.text, /^Recorded /);
    assert.equal(active.store.list().length, 1);
  });

  test("refuses without evidence", async () => {
    const active = runtime();
    const result = await runGotchaTool(active, { ...ADD, evidence: "hmm" });
    assert.match(result.text, /needs evidence/);
    assert.equal(active.store.list().length, 0);
  });

  test("refuses an oversized summary", async () => {
    const active = runtime();
    const result = await runGotchaTool(active, { ...ADD, summary: "x".repeat(201) });
    assert.match(result.text, /keep it under/);
    assert.equal(active.store.list().length, 0);
  });

  test("refuses a near-duplicate and names the existing id", async () => {
    const active = runtime();
    await runGotchaTool(active, ADD);
    const result = await runGotchaTool(active, {
      ...ADD,
      summary: "Invoice totals are integer cents; CSV export drops lines containing a comma",
    });
    assert.match(result.text, /looks like/);
    assert.equal(active.store.list().length, 1);
  });

  test("allows a genuinely different gotcha", async () => {
    const active = runtime();
    await runGotchaTool(active, ADD);
    const result = await runGotchaTool(active, {
      action: "add",
      summary: "Session cookies are dropped on redirect unless SameSite is explicitly set to none",
      evidence: "Login worked locally but not behind the proxy; the cookie never reached the browser",
    });
    assert.match(result.text, /^Recorded /);
    assert.equal(active.store.list().length, 2);
  });

  test("enforces the session write cap", async () => {
    const active = runtime({ sessionWriteCap: 1 });
    await runGotchaTool(active, ADD);
    const result = await runGotchaTool(active, {
      action: "add",
      summary: "Redis keys omit the tenant id so one tenant can read another's cached rows",
      evidence: "Support reported cross-tenant data; the cache key was built before tenancy existed",
    });
    assert.match(result.text, /cap/);
    assert.equal(active.store.list().length, 1);
  });
});

describe("other actions", () => {
  test("read returns the full record and withdraws a staged line", async () => {
    const active = runtime();
    const added = await runGotchaTool(active, ADD);
    const id = added.text.replace("Recorded ", "").replace(".", "");
    active.surfacer.stage(active.store.list());
    assert.equal(active.surfacer.pending().length, 1);

    const result = await runGotchaTool(active, { action: "read", id });
    assert.match(result.text, /Evidence:/);
    assert.match(result.text, /Covers: src\/billing\//);
    assert.equal(active.surfacer.pending().length, 0);
  });

  test("read of a missing id says so", async () => {
    assert.match((await runGotchaTool(runtime(), { action: "read", id: "nope" })).text, /No gotcha with id/);
  });

  test("search finds a recorded gotcha by keyword", async () => {
    const active = runtime();
    await runGotchaTool(active, ADD);
    const result = await runGotchaTool(active, { action: "search", query: "invoice cents comma" });
    assert.match(result.text, /invoice/i);
    assert.match(result.text, /keyword results only/);
  });

  test("search on an empty store says nothing is recorded", async () => {
    const result = await runGotchaTool(runtime(), { action: "search", query: "anything" });
    assert.match(result.text, /No gotchas recorded/);
  });

  test("update changes a field", async () => {
    const active = runtime();
    const added = await runGotchaTool(active, ADD);
    const id = added.text.replace("Recorded ", "").replace(".", "");
    const result = await runGotchaTool(active, { action: "update", id, summary: "Rewritten summary" });
    assert.match(result.text, /^Updated /);
    assert.equal(active.store.get(id)?.summary, "Rewritten summary");
  });

  test("update needs at least one field", async () => {
    const active = runtime();
    const added = await runGotchaTool(active, ADD);
    const id = added.text.replace("Recorded ", "").replace(".", "");
    assert.match((await runGotchaTool(active, { action: "update", id })).text, /at least one field/);
  });

  test("retire requires a reason", async () => {
    const active = runtime();
    const added = await runGotchaTool(active, ADD);
    const id = added.text.replace("Recorded ", "").replace(".", "");
    assert.match((await runGotchaTool(active, { action: "retire", id })).text, /needs a reason/);
    assert.equal(active.store.list().length, 1);
    assert.match((await runGotchaTool(active, { action: "retire", id, reason: "fixed upstream" })).text, /^Retired /);
    assert.equal(active.store.list().length, 0);
  });

  test("unknown actions are reported", async () => {
    assert.match((await runGotchaTool(runtime(), { action: "dance" })).text, /Unknown action/);
  });
});
