/* What retrieval can and cannot do, measured rather than asserted.

   Run: npm run bench
   With embeddings: PI_GOTCHA_EMBEDDINGS=local npm run bench

   Two numbers matter and they pull against each other: recall (does the right gotcha come
   back) and silence (does an unanswerable query come back empty). The assertions are weak;
   the printed table is the point. */

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { GOTCHAS, QUERIES, type Query } from "./fixtures/corpus.ts";
import { prune } from "../extensions/lib/rank.ts";
import { DEFAULTS } from "../extensions/lib/settings.ts";
import { hybridSearch, refreshSemantic, type Runtime } from "../extensions/lib/runtime.ts";
import { cleanup, runtimeFor, tempRoot } from "./helpers.ts";

const AT = 3;
const KINDS: Query["kind"][] = ["verbatim", "synonym", "typo", "path", "task", "distractor"];

let root = "";
let runtime: Runtime;
let semantic = false;

before(async () => {
  root = tempRoot();
  const provider = process.env.PI_GOTCHA_EMBEDDINGS === "local" ? "local" : "off";
  runtime = runtimeFor(root, { embeddings: { provider, model: "Xenova/all-MiniLM-L6-v2" } } as never);
  for (const gotcha of GOTCHAS) {
    runtime.store.add({
      summary: gotcha.summary,
      expected: "fixture expectation",
      actual: "fixture outcome",
      paths: gotcha.paths,
      aliases: gotcha.aliases,
      body: gotcha.body,
    });
  }
  if (provider === "local") {
    await refreshSemantic(runtime);
    semantic = runtime.semantic.ready;
    if (!semantic) console.log(`\n  embeddings unavailable: ${runtime.semantic.failure}`);
  }
});

after(() => cleanup(root));

interface Outcome {
  query: Query;
  found: boolean;
  kept: string[];
  returned: string[];
}

// The store derives ids from the summary, so fixture ids map through the same slug rule.
function idFor(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .slice(0, 6)
    .join("-");
}

async function evaluate(): Promise<Outcome[]> {
  const expectedId = new Map(GOTCHAS.map((g) => [g.id, idFor(g.summary)]));
  const outcomes: Outcome[] = [];
  for (const query of QUERIES) {
    const ranked = await hybridSearch(runtime, query.query, AT);
    const kept = prune(ranked, DEFAULTS.searchVeto);
    const wanted = query.expected.map((id) => expectedId.get(id) ?? id);
    outcomes.push({
      query,
      found: wanted.length > 0 && ranked.some((entry) => wanted.includes(entry.id)),
      returned: ranked.map((entry) => entry.id),
      kept: kept.map((entry) => entry.id),
    });
  }
  return outcomes;
}

function pct(part: number, whole: number): string {
  return whole ? `${Math.round((part / whole) * 100)}%`.padStart(4) : "   -";
}

describe(`retrieval @${AT}`, () => {
  test("recall by query kind, and what the relevance floor removes", async () => {
    const outcomes = await evaluate();
    const mode = semantic ? "lexical + embeddings" : "lexical only";

    const rows = [
      `\n  retrieval @${AT} — ${mode}`,
      "  " + "-".repeat(58),
      `  ${"kind".padEnd(12)} ${"recall".padStart(8)} ${"after floor".padStart(12)}`,
      "  " + "-".repeat(58),
    ];
    for (const kind of KINDS) {
      const subset = outcomes.filter((o) => o.query.kind === kind);
      if (!subset.length) continue;
      if (kind === "distractor") {
        const silent = subset.filter((o) => o.kept.length === 0).length;
        rows.push(`  ${"distractor".padEnd(12)} ${"n/a".padStart(8)} ${`${silent}/${subset.length} silent`.padStart(12)}`);
        continue;
      }
      const found = subset.filter((o) => o.found).length;
      const survived = subset.filter((o) => {
        const wanted = o.query.expected.map((id) => idFor(GOTCHAS.find((g) => g.id === id)!.summary));
        return o.kept.some((id) => wanted.includes(id));
      }).length;
      rows.push(
        `  ${kind.padEnd(12)} ${`${found}/${subset.length}`.padStart(5)} ${pct(found, subset.length)} ` +
          `${`${survived}/${subset.length}`.padStart(5)} ${pct(survived, subset.length)}`,
      );
    }
    const answerable = outcomes.filter((o) => o.query.kind !== "distractor");
    rows.push("  " + "-".repeat(58));
    rows.push(
      `  ${"overall".padEnd(12)} ${`${answerable.filter((o) => o.found).length}/${answerable.length}`.padStart(5)}`,
    );

    const misses = answerable.filter((o) => !o.found);
    if (misses.length) {
      rows.push(`\n  missed entirely (${misses.length}):`);
      for (const miss of misses) rows.push(`   [${miss.query.kind}] "${miss.query.query}"`);
    }
    console.log(rows.join("\n"));

    const verbatim = outcomes.filter((o) => o.query.kind === "verbatim");
    assert.ok(
      verbatim.filter((o) => o.found).length >= Math.ceil(verbatim.length * 0.75),
      "keyword search must find gotchas whose wording the query shares",
    );
  });

  test("paraphrases are the weak spot; embeddings are the fix", async () => {
    const outcomes = await evaluate();
    const score = (kind: Query["kind"]) => {
      const subset = outcomes.filter((o) => o.query.kind === kind);
      return subset.filter((o) => o.found).length / subset.length;
    };
    const verbatim = score("verbatim");
    const synonym = score("synonym");
    console.log(
      `\n  verbatim ${(verbatim * 100).toFixed(0)}% vs synonym ${(synonym * 100).toFixed(0)}%` +
        `${semantic ? "" : "  (run with PI_GOTCHA_EMBEDDINGS=local to compare)"}`,
    );
    assert.ok(verbatim >= synonym, "paraphrase should never beat exact wording");
  });
});
