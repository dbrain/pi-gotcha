/* Does a small model use this tool well?

   Run: node eval/tool-use.mjs
        GOTCHA_EVAL_URL=http://host:8090/v1 GOTCHA_EVAL_MODEL=<id> node eval/tool-use.mjs

   Each scenario is what a coding agent just lived through. Half deserve a gotcha and half
   do not. Two things are measured: what the model decides to record, and what our
   deterministic guards do with the attempt — the second is what matters, because the guards
   are what stand between a weak model and a store full of noise. */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TOOL_DESCRIPTION, TOOL_PARAMETERS, runGotchaTool } from "../extensions/lib/tool.ts";
import { createRuntime } from "../extensions/lib/runtime.ts";
import { DEFAULTS } from "../extensions/lib/settings.ts";

const URL = process.env.GOTCHA_EVAL_URL ?? "http://10.0.0.208:8090/v1";
const MODEL = process.env.GOTCHA_EVAL_MODEL ?? "gemma-4-12B-it-qat-UD-Q4_K_XL";

const SYSTEM =
  "You are a coding agent working in a repository. You have a `gotcha` tool for recording " +
  "hard-won project knowledge. After finishing a piece of work, decide whether anything you " +
  "learned is worth recording, and call the tool if so. If nothing is worth recording, say so " +
  "in one sentence and call nothing.";

const SCENARIOS = [
  {
    name: "silent data loss",
    record: true,
    prompt:
      "You spent two hours on a bug report about missing invoice rows. The CSV export writes " +
      "Invoice.total, which is an integer number of cents, formatted as 2,255.65. The finance " +
      "parser downstream treats any line containing a comma as corrupt and skips it silently, " +
      "with no error anywhere. You fixed it by quoting the field in src/export/csv.ts.",
  },
  {
    name: "ordering constraint",
    record: true,
    prompt:
      "The staging deploy failed three times. It turns out migrations must run twice: the first " +
      "pass creates the status enum and the second pass adds the column that uses it, because " +
      "the migration runner wraps each step in its own transaction. Running it once leaves the " +
      "database half-migrated with no error.",
  },
  {
    name: "hidden coupling",
    record: true,
    prompt:
      "You renamed the cache key prefix in src/cache/keys.ts. Everything passed locally, but the " +
      "billing reconciliation job in another repository reads those same keys directly from " +
      "Redis and silently returned zero rows. The two must be changed together.",
  },
  {
    name: "undocumented limit",
    record: true,
    prompt:
      "The vendor API docs say batch size is unlimited. In practice requests over 500 items " +
      "return HTTP 200 with a truncated body and no indication that anything was dropped. You " +
      "found this by counting responses in src/vendor/sync.ts.",
  },
  {
    name: "environment quirk",
    record: true,
    prompt:
      "Tests pass locally and fail in CI with a timezone error. CI runs in UTC, and the report " +
      "boundary code uses the server's local timezone, so the daily report includes a different " +
      "set of rows depending on where it runs.",
  },
  {
    name: "a preference",
    record: false,
    prompt:
      "The user told you they prefer two-space indentation in this repo and asked you to keep " +
      "the retry count at an even number. You updated the config accordingly.",
  },
  {
    name: "a task log",
    record: false,
    prompt:
      "You changed the retry count in src/worker/config.ts from 3 to 2 and updated the test that " +
      "asserts it. Everything passes.",
  },
  {
    name: "the code already says it",
    record: false,
    prompt:
      "You read src/users/get.ts and learned that getUser returns null when the id is unknown, " +
      "which its return type already says, and every caller already checks for null.",
  },
  {
    name: "worked as documented",
    record: false,
    prompt:
      "You added a new endpoint following the framework's routing guide. It worked first time, " +
      "exactly as the documentation described.",
  },
  {
    name: "a plan",
    record: false,
    prompt:
      "You noticed the cache key layout will need reworking once multi-tenancy lands, but nothing " +
      "is wrong today and no decision has been made yet.",
  },
  /* First-person phrasing, which is how the work actually arrives. It is what caught a model
     filling `expected`, omitting `actual`, and losing the gotcha to the guard. */
  {
    name: "first person: swallowed error",
    record: true,
    prompt:
      "Finally found it after three hours - retryOnConflict only works on the Postgres path. The " +
      "SQLite path swallows the conflict entirely and reports success, so the retry never fires.",
  },
  {
    name: "first person: false green",
    record: true,
    prompt:
      "Spent the morning on this: the deploy health check answers 200 before the worker pool has " +
      "registered, so the rollout reports green while the first half-minute of jobs is dropped.",
  },
  {
    name: "first person: task log",
    record: false,
    prompt: "I changed the timeout from 30s to 60s in config.ts. Remember that.",
  },
];

async function callModel(prompt) {
  const response = await fetch(`${URL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0,
      max_tokens: 600,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: prompt },
      ],
      tools: [{ type: "function", function: { name: "gotcha", description: TOOL_DESCRIPTION, parameters: TOOL_PARAMETERS } }],
    }),
  });
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  const payload = await response.json();
  const message = payload.choices?.[0]?.message ?? {};
  const call = (message.tool_calls ?? []).find((entry) => entry.function?.name === "gotcha");
  if (!call) return { attempted: false, said: (message.content ?? "").slice(0, 160) };
  let args = {};
  try {
    args = JSON.parse(call.function.arguments);
  } catch {
    return { attempted: true, malformed: true, args: {} };
  }
  return { attempted: args.action === "add", args };
}

const root = mkdtempSync(join(tmpdir(), "pi-gotcha-eval-"));
const runtime = createRuntime(root, {
  ...DEFAULTS,
  embeddings: { ...DEFAULTS.embeddings, provider: "off" },
  dailyWriteCap: 999,
  reviewWrites: "never",
});

const rows = [];
let correctDecision = 0;
let junkStopped = 0;
let goodStored = 0;

for (const scenario of SCENARIOS) {
  let outcome;
  try {
    outcome = await callModel(scenario.prompt);
  } catch (error) {
    console.error(`  ${scenario.name}: request failed — ${error.message}`);
    continue;
  }

  let guard = "-";
  let stored = false;
  let refusal = "";
  if (outcome.attempted) {
    const result = await runGotchaTool(runtime, { ...outcome.args, action: "add" });
    stored = result.text.startsWith("Recorded");
    guard = stored ? "stored" : "REFUSED";
    if (!stored) refusal = result.text;
  }

  if (refusal) {
    console.log(`\n  ! ${scenario.name} (wanted: ${scenario.record ? "record" : "skip"})`);
    console.log(`    summary: ${outcome.args?.summary ?? "(none)"}`);
    console.log(`    aliases: ${(outcome.args?.aliases ?? []).join(", ") || "(none)"}`);
    console.log(`    guard:   ${refusal}\n`);
  }

  const decidedRight = outcome.attempted === scenario.record;
  if (decidedRight) correctDecision += 1;
  if (!scenario.record && outcome.attempted && !stored) junkStopped += 1;
  if (scenario.record && stored) goodStored += 1;

  rows.push({
    name: scenario.name,
    want: scenario.record ? "record" : "skip",
    did: outcome.attempted ? "record" : "skip",
    aliases: outcome.args?.aliases?.length ?? 0,
    paths: outcome.args?.paths?.length ?? 0,
    guard,
  });
}

const worth = SCENARIOS.filter((s) => s.record).length;
const junk = SCENARIOS.length - worth;
const junkAttempts = rows.filter((row) => row.want === "skip" && row.did === "record").length;

console.log(`\n  ${MODEL}\n`);
console.log(`  ${"scenario".padEnd(24)} ${"want".padEnd(7)} ${"did".padEnd(7)} ${"alias".padEnd(6)} guard`);
console.log("  " + "-".repeat(78));
for (const row of rows) {
  console.log(
    `  ${row.name.padEnd(24)} ${row.want.padEnd(7)} ${row.did.padEnd(7)} ${String(row.aliases).padEnd(6)} ${row.guard}`,
  );
}
console.log("  " + "-".repeat(78));
console.log(`  judgement alone:      ${correctDecision}/${SCENARIOS.length} decisions matched`);
console.log(`  worth recording:      ${goodStored}/${worth} stored`);
console.log(`  junk attempted:       ${junkAttempts}/${junk}, of which guards stopped ${junkStopped}`);
console.log(`  final store:          ${runtime.store.list().length} gotchas\n`);

rmSync(root, { recursive: true, force: true });
