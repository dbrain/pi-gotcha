import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { runGotchaTool, TOOL_DESCRIPTION, TOOL_PARAMETERS } from "../extensions/lib/tool.ts";
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
  trigger: SAMPLE.trigger,
  paths: SAMPLE.paths,
  aliases: SAMPLE.aliases,
  body: SAMPLE.body,
};

const OTHER = {
  action: "add",
  summary: "Session cookies are dropped on redirect unless SameSite is set to none explicitly",
  expected: "The login cookie to survive the redirect back from the identity provider",
  actual: "The cookie never reached the browser, and only behind the proxy, with no error",
  trigger: "debugging a login that works locally but not behind the proxy",
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

  /* A 12B in a realistic session filled `expected` and silently omitted `actual`, losing two of
     three genuine gotchas to the guard above. Only `action` is schema-required, so the contract
     has to say out loud what an add needs. */
  test("the contract names every field an add requires", () => {
    assert.match(TOOL_DESCRIPTION, /add requires/i);
    for (const field of ["summary", "expected", "actual", "trigger", "aliases"]) {
      assert.ok(
        new RegExp(`add requires[^.]*\\b${field}\\b`, "i").test(TOOL_DESCRIPTION),
        `TOOL_DESCRIPTION never names ${field} among the fields an add requires`,
      );
    }
    assert.match(TOOL_PARAMETERS.properties.expected.description, /REQUIRED/);
    assert.match(TOOL_PARAMETERS.properties.actual.description, /REQUIRED/);
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

  /* Every one of these was, or would have been, wrongly refused by a junk pattern. The first is
     verbatim from a 12B in eval/tool-use.mjs. */
  const legitimate: Array<[string, string]> = [
    [
      "a parenthetical 'like'",
      "CSV export rows with commas (like formatted currency) are silently dropped by the downstream finance parser.",
    ],
    ["a parser that prefers something", "The XML parser prefers UTF-8 and silently mangles latin-1 payloads"],
    [
      "a genuine 'next time'",
      "Pods run pending migrations on boot, so the next time a pod starts the schema can change under a running query",
    ],
    ["a component that wants something", "The scheduler wants monotonic clocks and silently reorders jobs without them"],
  ];
  for (const [name, summary] of legitimate) {
    test(`records despite ${name}`, async () => {
      const active = runtime();
      const result = await runGotchaTool(active, { ...ADD, summary });
      assert.match(result.text, /^Recorded /, result.text);
      assert.equal(active.store.list().length, 1);
    });
  }

  test("refuses without a trigger, which is what makes it findable", async () => {
    const active = runtime();
    const result = await runGotchaTool(active, { ...ADD, trigger: "" });
    assert.match(result.text, /needs a `trigger`/);
    assert.equal(active.store.list().length, 0);
  });

  test("the trigger is stored and shown when read", async () => {
    const active = runtime();
    const id = idFromResult((await runGotchaTool(active, ADD)).text);
    assert.equal(active.store.get(id)?.trigger, SAMPLE.trigger);
    assert.match((await runGotchaTool(active, { action: "read", id })).text, /Comes up when: chasing rows/);
  });

  test("refuses a summary too vague to find again", async () => {
    const active = runtime();
    const result = await runGotchaTool(active, { ...ADD, summary: "Cache behaves oddly" });
    assert.match(result.text, /too vague/);
    assert.equal(active.store.list().length, 0);
  });

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
    const active = runtime({ dailyWriteCap: 1, reviewWrites: "never" });
    await runGotchaTool(active, ADD);
    const result = await runGotchaTool(active, OTHER);
    assert.match(result.text, /budget across all/);
    assert.equal(active.store.list().length, 1);
  });

  test("a fresh runtime over the same store still sees the budget spent", async () => {
    const active = runtime({ dailyWriteCap: 1, reviewWrites: "never" });
    await runGotchaTool(active, ADD);
    const second = runtimeFor(active.root, { dailyWriteCap: 1, reviewWrites: "never" });
    assert.match((await runGotchaTool(second, OTHER)).text, /budget across all/);
  });

  test("the reply says how much budget is left and that updates are free", async () => {
    const active = runtime({ dailyWriteCap: 3 });
    const result = await runGotchaTool(active, ADD);
    assert.match(result.text, /2 more can be recorded today/);
    assert.match(result.text, /updating existing gotchas is unlimited/);
  });

  test("updating never spends budget, however many times", async () => {
    const active = runtime({ dailyWriteCap: 1 });
    const id = idFromResult((await runGotchaTool(active, ADD)).text);
    for (let i = 0; i < 5; i += 1) {
      const result = await runGotchaTool(active, { action: "update", id, body: `revision ${i}` });
      assert.match(result.text, /^Updated /);
    }
    assert.equal(active.ledger.writesToday(), 1);
  });

  test("a raised budget is spent without asking", async () => {
    const active = runtime({ dailyWriteCap: 1 });
    await runGotchaTool(active, ADD);
    active.ledger.raiseToday(5);
    let asked = false;
    const result = await runGotchaTool(active, OTHER, {
      choose: async () => {
        asked = true;
        return "record";
      },
    });
    assert.match(result.text, /^Recorded /);
    assert.equal(asked, false);
    assert.equal(active.ledger.overridesToday(), 0);
  });
});

describe("review", () => {
  const overBudget = { dailyWriteCap: 1 };

  test("offers record, replace and skip when over budget", async () => {
    const active = runtime(overBudget);
    await runGotchaTool(active, ADD);
    const offered: string[][] = [];
    await runGotchaTool(active, OTHER, {
      choose: async (_question, options) => {
        offered.push(options.map((option) => option.value));
        return "skip";
      },
    });
    assert.deepEqual(offered[0], ["record", "replace", "skip"]);
  });

  test("recording anyway counts as an approved override", async () => {
    const active = runtime(overBudget);
    await runGotchaTool(active, ADD);
    const result = await runGotchaTool(active, OTHER, { choose: async () => "record" });
    assert.match(result.text, /^Recorded /);
    assert.equal(active.store.list().length, 2);
    assert.equal(active.ledger.overridesToday(), 1);
  });

  test("skipping records nothing", async () => {
    const active = runtime(overBudget);
    await runGotchaTool(active, ADD);
    const result = await runGotchaTool(active, OTHER, { choose: async () => "skip" });
    assert.match(result.text, /skipped/);
    assert.equal(active.store.list().length, 1);
  });

  test("dismissing the prompt records nothing", async () => {
    const active = runtime(overBudget);
    await runGotchaTool(active, ADD);
    await runGotchaTool(active, OTHER, { choose: async () => null });
    assert.equal(active.store.list().length, 1);
  });

  test("replacing retires the old one, keeps the store the same size, and spends no budget", async () => {
    const active = runtime(overBudget);
    const firstId = idFromResult((await runGotchaTool(active, ADD)).text);
    assert.equal(active.ledger.writesToday(), 1);

    const asked: string[] = [];
    const result = await runGotchaTool(active, OTHER, {
      choose: async (question, options) => {
        asked.push(question);
        return asked.length === 1 ? "replace" : options[0].value;
      },
    });

    assert.match(result.text, new RegExp(`in place of ${firstId}`));
    assert.equal(active.store.get(firstId), undefined);
    assert.equal(active.store.list().length, 1);
    assert.equal(active.ledger.writesToday(), 1);
    assert.match(asked[1], /Which gotcha should this replace/);
  });

  test("today's writes are offered as replacement candidates, labelled", async () => {
    const active = runtime(overBudget);
    const firstId = idFromResult((await runGotchaTool(active, ADD)).text);
    const labels: string[] = [];
    await runGotchaTool(active, OTHER, {
      choose: async (_question, options) => {
        labels.push(...options.map((option) => option.label));
        return labels.length > 3 ? null : "replace";
      },
    });
    assert.ok(labels.some((label) => label.startsWith(firstId) && label.endsWith("(today)")));
  });

  test("with no one to ask, the write becomes a proposal", async () => {
    const active = runtime(overBudget);
    await runGotchaTool(active, ADD);
    const result = await runGotchaTool(active, OTHER);
    assert.match(result.text, /^Proposed /);
    assert.equal(active.store.list().length, 1);
    assert.equal(active.store.proposals().length, 1);
  });

  test("reviewWrites always asks even under budget", async () => {
    const active = runtime({ reviewWrites: "always" });
    let asked = 0;
    const result = await runGotchaTool(active, ADD, {
      choose: async () => {
        asked += 1;
        return "record";
      },
    });
    assert.equal(asked, 1);
    assert.match(result.text, /^Recorded /);
    assert.equal(active.ledger.overridesToday(), 0);
  });

  test("reviewWrites always proposes when nobody can be asked", async () => {
    const active = runtime({ reviewWrites: "always" });
    assert.match((await runGotchaTool(active, ADD)).text, /^Proposed /);
    assert.equal(active.store.proposals().length, 1);
  });

  test("reviewWrites never refuses over budget without asking", async () => {
    const active = runtime({ dailyWriteCap: 1, reviewWrites: "never" });
    await runGotchaTool(active, ADD);
    let asked = false;
    const result = await runGotchaTool(active, OTHER, {
      choose: async () => {
        asked = true;
        return "record";
      },
    });
    assert.equal(asked, false);
    assert.match(result.text, /budget across all/);
  });

  test("under budget with the default mode, nothing is asked", async () => {
    const active = runtime({ dailyWriteCap: 5 });
    let asked = false;
    await runGotchaTool(active, ADD, {
      choose: async () => {
        asked = true;
        return "record";
      },
    });
    assert.equal(asked, false);
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

  test("refuses a body that is really pasted output", async () => {
    const active = runtime();
    const result = await runGotchaTool(active, { ...ADD, body: "x".repeat(9000) });
    assert.match(result.text, /keep it under 8000/);
    assert.equal(active.store.list().length, 0);
  });

  test("refuses an oversized body on update too", async () => {
    const active = runtime();
    const id = idFromResult((await runGotchaTool(active, ADD)).text);
    assert.match((await runGotchaTool(active, { action: "update", id, body: "x".repeat(9000) })).text, /keep it under/);
  });

  test("a long body is delivered in pieces", async () => {
    const active = runtime({ readChunk: 50 });
    const id = idFromResult((await runGotchaTool(active, { ...ADD, body: "b".repeat(200) })).text);

    const first = await runGotchaTool(active, { action: "read", id });
    assert.match(first.text, /Expected:/);
    assert.match(first.text, /…150 more characters; read again with offset: 50/);
    assert.ok(first.text.includes("b".repeat(50)), "delivers the first chunk");
    assert.ok(!first.text.includes("b".repeat(51)), "and no more than the chunk");

    const next = await runGotchaTool(active, { action: "read", id, offset: 50 });
    assert.match(next.text, new RegExp(`^# ${id} \\(from 50\\)`));
    assert.match(next.text, /…100 more characters/);
  });

  test("continuing a body is not a second opening", async () => {
    const active = runtime({ readChunk: 50 });
    const id = idFromResult((await runGotchaTool(active, { ...ADD, body: "b".repeat(200) })).text);
    await runGotchaTool(active, { action: "read", id });
    await runGotchaTool(active, { action: "read", id, offset: 50 });
    assert.equal(active.ledger.usage(id).read, 1);
  });

  test("a short body arrives whole, with nothing to continue", async () => {
    const active = runtime();
    const id = idFromResult((await runGotchaTool(active, ADD)).text);
    const result = await runGotchaTool(active, { action: "read", id });
    assert.doesNotMatch(result.text, /more characters/);
    assert.match(result.text, new RegExp(SAMPLE.body!.slice(0, 20)));
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
