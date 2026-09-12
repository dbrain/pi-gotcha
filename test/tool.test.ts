import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { runGotchaTool } from "../extensions/lib/tool.ts";
import { jaccard, overlaps, tokens } from "../extensions/lib/text.ts";
import { cleanup, idFromResult, runtimeFor, SAMPLE, tempRoot } from "./helpers.ts";
import type { Settings } from "../extensions/lib/settings.ts";

const roots: string[] = [];
function runtime(overrides: Partial<Settings> = {}) {
  const root = tempRoot();
  roots.push(root);
  return runtimeFor(root, overrides);
}

after(() => roots.forEach(cleanup));

const ADD = {
  action: "add",
  summary: SAMPLE.summary,
  expected: SAMPLE.expected,
  actual: SAMPLE.actual,
  paths: SAMPLE.paths,
  aliases: SAMPLE.aliases,
  body: SAMPLE.body,
};

const OTHER = {
  action: "add",
  summary: "Session cookies are dropped on redirect unless SameSite is set to none explicitly",
  expected: "The login cookie to survive the redirect back from the identity provider",
  actual: "The cookie never reached the browser, and only behind the proxy, with no error",
  aliases: ["auth", "login"],
};

describe("text helpers", () => {
  test("identical text scores 1", () => assert.equal(jaccard("alpha beta gamma", "alpha beta gamma"), 1));
  test("disjoint text scores 0", () => assert.equal(jaccard("alpha beta", "gamma delta"), 0));
  test("words of two characters or fewer are ignored", () => assert.equal(jaccard("a an of", "a an of"), 0));
  test("stopwords are ignored", () => assert.equal(jaccard("the and that", "the and that"), 0));
  test("tokens drops stopwords and short words", () =>
    assert.deepEqual([...tokens("the invoice is a total")], ["invoice", "total"]));
  test("overlaps is true on one shared real word", () =>
    assert.equal(overlaps("rename the button", "the button label"), true));
  test("overlaps is false when only stopwords are shared", () =>
    assert.equal(overlaps("rename the screen", "the deploy migrations"), false));
});

describe("what counts as a gotcha", () => {
  test("records a well-formed one", async () => {
    const active = runtime();
    const result = await runGotchaTool(active, ADD);
    assert.match(result.text, /^Recorded /);
    assert.equal(active.store.list().length, 1);
  });

  test("refuses without both expected and actual", async () => {
    const active = runtime();
    assert.match((await runGotchaTool(active, { ...ADD, actual: "broke" })).text, /needs both/);
    assert.match((await runGotchaTool(active, { ...ADD, expected: "" })).text, /needs both/);
    assert.equal(active.store.list().length, 0);
  });

  const junk: Array<[string, string]> = [
    ["a stated preference", "User prefers even numbers for the retry count"],
    ["someone's request", "The user asked me to keep the timeout at 30 seconds"],
    ["a task log", "I changed the retry count from 3 to 2 in the worker config"],
    ["a plan", "TODO: revisit the cache key once the tenant work lands"],
    ["a reminder", "Next time we should check the migration order before deploying"],
  ];
  for (const [name, summary] of junk) {
    test(`refuses ${name}`, async () => {
      const active = runtime();
      const result = await runGotchaTool(active, { ...ADD, summary });
      assert.match(result.text, /Not recorded/);
      assert.equal(active.store.list().length, 0);
    });
  }

  test("refuses without enough aliases", async () => {
    const active = runtime();
    const result = await runGotchaTool(active, { ...ADD, aliases: ["money"] });
    assert.match(result.text, /at least 2 aliases/);
    assert.equal(active.store.list().length, 0);
  });

  test("refuses an oversized summary", async () => {
    const active = runtime();
    assert.match((await runGotchaTool(active, { ...ADD, summary: "x".repeat(201) })).text, /keep it under/);
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
    assert.match((await runGotchaTool(active, OTHER)).text, /^Recorded /);
    assert.equal(active.store.list().length, 2);
  });
});

describe("write budget", () => {
  test("caps writes per day across sessions, not per session", async () => {
    const active = runtime({ dailyWriteCap: 1 });
    await runGotchaTool(active, ADD);
    const result = await runGotchaTool(active, OTHER);
    assert.match(result.text, /cap across all sessions/);
    assert.equal(active.store.list().length, 1);
  });

  test("a fresh runtime over the same store still sees the budget spent", async () => {
    const active = runtime({ dailyWriteCap: 1 });
    await runGotchaTool(active, ADD);
    const second = runtimeFor(active.root, { dailyWriteCap: 1 });
    assert.match((await runGotchaTool(second, OTHER)).text, /cap across all sessions/);
  });

  test("the reply says how much budget is left", async () => {
    const active = runtime({ dailyWriteCap: 3 });
    assert.match((await runGotchaTool(active, ADD)).text, /2 more can be recorded today/);
  });
});

describe("other actions", () => {
  test("read returns the record, withdraws the staged line, and counts as opened", async () => {
    const active = runtime();
    const id = idFromResult((await runGotchaTool(active, ADD)).text);
    active.surfacer.stage(active.store.list());
    assert.equal(active.surfacer.pending().length, 1);

    const result = await runGotchaTool(active, { action: "read", id });
    assert.match(result.text, /Expected:/);
    assert.match(result.text, /Actually:/);
    assert.equal(active.surfacer.pending().length, 0);
    assert.equal(active.ledger.usage(id).read, 1);
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
    assert.match((await runGotchaTool(runtime(), { action: "search", query: "anything" })).text, /No gotchas recorded/);
  });

  test("list is capped and says how many it left out", async () => {
    const active = runtime({ listLimit: 1, dailyWriteCap: 9 });
    await runGotchaTool(active, ADD);
    await runGotchaTool(active, OTHER);
    const result = await runGotchaTool(active, { action: "list" });
    assert.match(result.text, /…and 1 more/);
    assert.equal(result.text.split("\n").filter((l) => l.includes(" — ")).length, 1);
  });

  test("update changes a field", async () => {
    const active = runtime();
    const id = idFromResult((await runGotchaTool(active, ADD)).text);
    const result = await runGotchaTool(active, { action: "update", id, summary: "Rewritten summary of the same fact" });
    assert.match(result.text, /^Updated /);
    assert.equal(active.store.get(id)?.summary, "Rewritten summary of the same fact");
  });

  test("update refuses junk wording too", async () => {
    const active = runtime();
    const id = idFromResult((await runGotchaTool(active, ADD)).text);
    assert.match((await runGotchaTool(active, { action: "update", id, summary: "I changed it to 2" })).text, /Not recorded/);
  });

  test("update needs at least one field", async () => {
    const active = runtime();
    const id = idFromResult((await runGotchaTool(active, ADD)).text);
    assert.match((await runGotchaTool(active, { action: "update", id })).text, /at least one field/);
  });

  test("retire requires a reason, logs it, and forgets its counters", async () => {
    const active = runtime();
    const id = idFromResult((await runGotchaTool(active, ADD)).text);
    active.ledger.recordSurfaced([id]);
    assert.match((await runGotchaTool(active, { action: "retire", id })).text, /needs a reason/);
    assert.equal(active.store.list().length, 1);

    const result = await runGotchaTool(active, { action: "retire", id, reason: "fixed upstream in 2.1" });
    assert.match(result.text, /^Retired /);
    assert.equal(active.store.list().length, 0);
    assert.equal(active.ledger.usage(id).surfaced, 0);
  });

  test("retire of a missing id says so", async () => {
    assert.match((await runGotchaTool(runtime(), { action: "retire", id: "ghost", reason: "x" })).text, /No gotcha/);
  });

  test("unknown actions are reported", async () => {
    assert.match((await runGotchaTool(runtime(), { action: "dance" })).text, /Unknown action/);
  });
});
