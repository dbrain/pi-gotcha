/* The same question as tool-use.mjs, but on real material rather than invented scenarios.

   Every episode below actually happened while building this package: ten things that cost real
   investigation, and six that were ordinary work. They are unlabelled and shuffled together, in
   the order they occurred, the way a session log would be.

   Run: node eval/from-session.mjs

   Caveat worth stating: a human wrote these summaries from the session, so they are real events
   but filtered through one person's compression. A raw transcript would be a harder test. */

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
  "hard-won project knowledge. You have just finished a piece of work. Decide whether anything " +
  "you learned is worth recording for a future session, and call the tool if so. If nothing is " +
  "worth recording, say so in one sentence and call nothing.";

const EPISODES = [
  {
    name: "parameter properties",
    record: true,
    text:
      "The extension crashed on load with a syntax error. Node runs TypeScript by stripping types " +
      "rather than compiling, so constructor parameter properties — constructor(private readonly " +
      "store: Store) — are not supported, because they have runtime behaviour. Rewrote both classes " +
      "to declare fields and assign them in the constructor body.",
  },
  {
    name: "ran the tests",
    record: false,
    text: "Ran the test suite after the refactor. 179 tests, all passing, took about a second.",
  },
  {
    name: "sharp build",
    record: true,
    text:
      "Installing @huggingface/transformers failed: it depends on sharp for image inputs, and sharp " +
      "tried to build from source on this Node version and died asking for node-addon-api. Nothing " +
      "here uses images, so installing with --ignore-scripts skips the build and onnxruntime plus " +
      "the embedding pipeline still load fine.",
  },
  {
    name: "wrote a readme section",
    record: false,
    text: "Wrote the README section describing the storage format and the three retrieval channels.",
  },
  {
    name: "renderer parse order",
    record: true,
    text:
      "The installer aborted rendering models.json. The template renderer parsed the file as JSON " +
      "before substituting variables, but one template deliberately has a bare placeholder where a " +
      "number goes — \"contextWindow\": ${FLASH_CTX} — which is not valid JSON until substitution " +
      "happens. Substitution has to run on the text first.",
  },
  {
    name: "renamed a setting",
    record: false,
    text: "Renamed the overBudgetPrompt boolean to reviewWrites with three modes, and updated its tests.",
  },
  {
    name: "env clobbering",
    record: true,
    text:
      "A one-off override was silently ignored: the install script did `set -a; source endpoints.env`, " +
      "which overwrites anything already in the environment. Per-device overrides never worked. Load " +
      "order now has to be precedence order, first value wins, and set-but-empty has to count as a " +
      "decision so a variable can be turned off.",
  },
  {
    name: "idle timeout",
    record: true,
    text:
      "Found that the agent drops a request after five minutes of no bytes, by default. With a local " +
      "model that queues behind other clients and then reads a 60k-token prompt at roughly 200 tokens " +
      "per second, that limit is reached before the first token arrives, so long prompts fail on slow " +
      "servers unless the idle timeout is raised.",
  },
  {
    name: "created a repo",
    record: false,
    text: "Created a private GitHub repository and pushed the first commit to it.",
  },
  {
    name: "foreground subagents",
    record: true,
    text:
      "A subagent that needed a tool from an extension failed to launch. Foreground child agents run " +
      "inside the parent process and never load the parent's ambient extensions, so a child only gets " +
      "an extension if its own config names the provider path explicitly alongside the tool name. " +
      "Background children do inherit them, which is why it looked inconsistent.",
  },
  {
    name: "context precedence",
    record: true,
    text:
      "The global defaultSubagentContext setting replaces each agent's own defaultContext, rather than " +
      "the agent default winning. So packaged agents that declare fork run fresh once the global is " +
      "set, which is the opposite of what the agent files suggest.",
  },
  {
    name: "added an npm script",
    record: false,
    text: "Added an npm script so the benchmark can be run with one command.",
  },
  {
    name: "ratio gate on small sets",
    record: true,
    text:
      "An unrelated prompt surfaced a note about migrations. The relevance gate compares the top " +
      "result against the best one that would not have been shown anyway, but when there are fewer " +
      "candidates than the cap there is no rival at all, so a single weak match trivially passes. A " +
      "ratio cannot discriminate on a set that small.",
  },
  {
    name: "regex on bare verbs",
    record: true,
    text:
      "A genuine finding was rejected by the junk filter. The summary said rows with commas (like " +
      "formatted currency) are dropped, and the preference pattern matched the word like. Matching " +
      "bare verbs is wrong here: prefers, likes and wants all appear in ordinary technical prose, so " +
      "the patterns have to require a person doing the preferring.",
  },
  {
    name: "searxng defaults",
    record: true,
    text:
      "The search container returned HTML but the JSON API 404'd. SearXNG ships with only the html " +
      "format enabled, so json has to be added to search.formats explicitly; separately its rate " +
      "limiter needs a valkey container, so it must be off for a LAN instance with no valkey.",
  },
  {
    name: "committed the work",
    record: false,
    text: "Committed the day's work with a message describing the review flow and pushed it.",
  },
];

async function callModel(text) {
  const response = await fetch(`${URL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0,
      max_tokens: 700,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: text },
      ],
      tools: [{ type: "function", function: { name: "gotcha", description: TOOL_DESCRIPTION, parameters: TOOL_PARAMETERS } }],
    }),
  });
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  const payload = await response.json();
  const message = payload.choices?.[0]?.message ?? {};
  const call = (message.tool_calls ?? []).find((entry) => entry.function?.name === "gotcha");
  if (!call) return { attempted: false };
  try {
    const args = JSON.parse(call.function.arguments);
    return { attempted: args.action === "add", args };
  } catch {
    return { attempted: true, args: {}, malformed: true };
  }
}

const root = mkdtempSync(join(tmpdir(), "pi-gotcha-session-"));
const runtime = createRuntime(root, {
  ...DEFAULTS,
  embeddings: { ...DEFAULTS.embeddings, provider: "off" },
  dailyWriteCap: 999,
  reviewWrites: "never",
});

const rows = [];
for (const episode of EPISODES) {
  let outcome;
  try {
    outcome = await callModel(episode.text);
  } catch (error) {
    console.error(`  ${episode.name}: request failed — ${error.message}`);
    continue;
  }

  let guard = "-";
  let stored = false;
  if (outcome.attempted) {
    const result = await runGotchaTool(runtime, { ...outcome.args, action: "add" });
    stored = result.text.startsWith("Recorded");
    guard = stored ? "stored" : result.text.slice(0, 60);
  }

  rows.push({
    name: episode.name,
    want: episode.record ? "record" : "skip",
    did: outcome.attempted ? "record" : "skip",
    right: outcome.attempted === episode.record,
    trigger: outcome.args?.trigger ?? "",
    summary: outcome.args?.summary ?? "",
    guard,
    stored,
  });
}

const worth = EPISODES.filter((e) => e.record).length;
console.log(`\n  ${MODEL} — episodes from building this package\n`);
console.log(`  ${"episode".padEnd(24)} ${"want".padEnd(7)} ${"did".padEnd(7)} guard`);
console.log("  " + "-".repeat(78));
for (const row of rows) {
  console.log(`  ${row.name.padEnd(24)} ${row.want.padEnd(7)} ${row.did.padEnd(7)} ${row.guard}`);
}
console.log("  " + "-".repeat(78));
console.log(`  decisions correct:  ${rows.filter((r) => r.right).length}/${rows.length}`);
console.log(`  worth recording:    ${rows.filter((r) => r.want === "record" && r.stored).length}/${worth} stored`);
console.log(
  `  false positives:    ${rows.filter((r) => r.want === "skip" && r.did === "record").length} attempted, ` +
    `${rows.filter((r) => r.want === "skip" && r.stored).length} stored`,
);

console.log(`\n  what it wrote:\n`);
for (const row of rows.filter((r) => r.stored)) {
  console.log(`  · ${row.summary}`);
  console.log(`    trigger: ${row.trigger || "(none)"}\n`);
}

rmSync(root, { recursive: true, force: true });
