/* Choosing the relevance floor, rather than guessing it.

   Run: PI_GOTCHA_EMBEDDINGS=local npm run floors

   Two quantities pull against each other:
     recall  — an answerable query still gets its gotcha after filtering
     silence — an unanswerable query gets nothing back

   A floor on cosine alone buys silence and costs recall on queries that keyword search
   answers perfectly (a query naming a file, or phrased as the task). So the second rule
   keeps a result that either channel is confident about, and uses cosine only to veto
   what is plainly unrelated. */

import { after, before, describe, test } from "node:test";
import { GOTCHAS, QUERIES } from "./fixtures/corpus.ts";
import type { Ranked } from "../extensions/lib/rank.ts";
import { hybridSearch, refreshSemantic, type Runtime } from "../extensions/lib/runtime.ts";
import { cleanup, runtimeFor, tempRoot } from "./helpers.ts";

const AT = 3;
let root = "";
let runtime: Runtime;
let ready = false;

function idFor(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .slice(0, 6)
    .join("-");
}

before(async () => {
  root = tempRoot();
  runtime = runtimeFor(root, {
    embeddings: { provider: "local", model: "Xenova/all-MiniLM-L6-v2" },
  } as never);
  for (const gotcha of GOTCHAS) {
    runtime.store.add({
      summary: gotcha.summary,
      evidence: "fixture",
      paths: gotcha.paths,
      aliases: gotcha.aliases,
      body: gotcha.body,
    });
  }
  await refreshSemantic(runtime);
  ready = runtime.semantic.ready;
});

after(() => cleanup(root));

interface Case {
  wanted: string[];
  distractor: boolean;
  ranked: Ranked[];
}

function semanticOnly(ranked: Ranked[], floor: number): Ranked[] {
  return ranked.filter((entry) => (entry.semantic ?? 0) >= floor);
}

function eitherChannel(ranked: Ranked[], veto: number, relative = 0.35): Ranked[] {
  const best = Math.max(...ranked.map((entry) => entry.lexical ?? 0), 0);
  return ranked.filter((entry) => {
    if ((entry.semantic ?? 0) < veto) return false;
    return (entry.semantic ?? 0) >= 0.45 || (best > 0 && (entry.lexical ?? 0) >= best * relative);
  });
}

describe("relevance floor sweep", () => {
  test("recall against silence", async () => {
    if (!ready) {
      console.log(`\n  skipped: embeddings unavailable (${runtime.semantic.failure ?? "not enabled"})`);
      return;
    }

    const cases: Case[] = [];
    for (const query of QUERIES) {
      cases.push({
        wanted: query.expected.map((id) => idFor(GOTCHAS.find((g) => g.id === id)!.summary)),
        distractor: query.kind === "distractor",
        ranked: await hybridSearch(runtime, query.query, AT),
      });
    }

    const answerable = cases.filter((entry) => !entry.distractor);
    const distractors = cases.filter((entry) => entry.distractor);

    const score = (keep: (ranked: Ranked[]) => Ranked[]) => {
      const recall = answerable.filter((entry) =>
        keep(entry.ranked).some((hit) => entry.wanted.includes(hit.id)),
      ).length;
      const silent = distractors.filter((entry) => keep(entry.ranked).length === 0).length;
      return { recall, silent };
    };

    const rows = [
      "\n  floor sweep — recall (of 40 answerable) vs silence (of 5 unanswerable)",
      "  " + "-".repeat(62),
      `  ${"floor".padEnd(7)} ${"cosine only".padEnd(22)} ${"either channel, cosine veto".padEnd(28)}`,
      "  " + "-".repeat(62),
    ];
    for (let floor = 0.1; floor <= 0.6001; floor += 0.05) {
      const a = score((ranked) => semanticOnly(ranked, floor));
      const b = score((ranked) => eitherChannel(ranked, floor));
      rows.push(
        `  ${floor.toFixed(2).padEnd(7)} ` +
          `recall ${String(a.recall).padStart(2)}/40  silent ${a.silent}/5   `.padEnd(22) +
          `  recall ${String(b.recall).padStart(2)}/40  silent ${b.silent}/5`,
      );
    }
    const unfiltered = score((ranked) => ranked);
    rows.push("  " + "-".repeat(62));
    rows.push(`  none    recall ${unfiltered.recall}/40  silent ${unfiltered.silent}/5`);
    console.log(rows.join("\n"));
  });
});
