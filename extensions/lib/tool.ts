import { prune } from "./rank.ts";
import { byId, gotchas, hybridSearch, refreshSemantic, type Runtime } from "./runtime.ts";
import { scopeOf } from "./surfacing.ts";
import { jaccard, tokens } from "./text.ts";
import { MAX_SUMMARY, type Gotcha, type GotchaDraft } from "./store.ts";

export const TOOL_PARAMETERS = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["search", "read", "add", "update", "retire", "list"] },
    query: { type: "string", description: "search: what you want to know, in your own words." },
    id: { type: "string", description: "read, update, retire: the gotcha id." },
    summary: {
      type: "string",
      description: `add, update: ONE line stating the surprising fact and its consequence, under ${MAX_SUMMARY} characters.`,
    },
    expected: {
      type: "string",
      description: "add, update: what you expected to happen, or what the code looks like it does.",
    },
    actual: {
      type: "string",
      description: "add, update: what actually happened, and how you found out.",
    },
    trigger: {
      type: "string",
      description:
        "add, update: the work someone will be doing when they next need this, as a task — " +
        '"adding a column to the orders table", "chasing duplicate confirmation emails". This is ' +
        "how the gotcha gets found later, so write the situation, not the fact.",
    },
    paths: {
      type: "array",
      items: { type: "string" },
      description:
        "add, update: files or directories this covers, repo-relative; end a directory with '/'. " +
        "Omit for knowledge that is not tied to any path; knowledge that covers the whole repo " +
        "is reached by relevance rather than by touch.",
    },
    aliases: {
      type: "array",
      items: { type: "string" },
      description:
        "add, update: other words someone might search for instead of your wording. This is what " +
        "makes the gotcha findable later; give at least two.",
    },
    body: { type: "string", description: "add, update: the detail, including exact values, names and limits." },
    reason: { type: "string", description: "retire: why this is no longer true." },
    limit: { type: "number", description: "search, list: maximum results." },
    offset: { type: "number", description: "read: continue a long body from this character offset." },
  },
  required: ["action"],
} as const;

/* Small models follow a pattern far better than they follow a rule, so the contract is shown
   rather than only stated: one example of each answer the tool can give. */
export const TOOL_DESCRIPTION =
  "Hard-won project knowledge: things that cost real investigation and that reading the code does " +
  "not tell you. search it when you hit surprising behaviour or start work in an unfamiliar area; " +
  "relevant gotchas also arrive unasked when you touch the files they cover. " +
  "add one ONLY when something surprised you and would surprise the next session the same way. " +
  "Before adding, answer two questions: would someone find this by reading the code (then do not " +
  "add it), and what will someone be doing when they next need it (that is the trigger). " +
  "\n\nRECORD, for example: " +
  '{ action: "add", summary: "Invoice totals are integer cents; the CSV export drops any line ' +
  'containing a comma", expected: "the export to show the formatted total like every other ' +
  'column", actual: "the row vanished with no error at all; the parser treats a comma as ' +
  'corruption", trigger: "chasing rows missing from a finance export", paths: ["src/billing/"], ' +
  'aliases: ["money formatting", "thousands separator", "missing rows in export"] }' +
  "\n\nDO NOT RECORD: \"I changed the retry count from 3 to 2\" (what you did, not what surprised " +
  'you), "the user prefers tabs" (a preference), "TODO: revisit the cache key" (a plan), ' +
  '"getUser returns null when the id is unknown" (the code says so). ' +
  "If the knowledge belongs at one line of code, write a comment there instead. " +
  "Prefer update over add: a near-duplicate is refused, and updating costs nothing.";

/* Every pattern here has to name a person doing the preferring, planning or doing. Matching the
   bare verbs rejected real findings: a live 12B wrote "rows with commas (like formatted
   currency) are silently dropped" and `likes?` matched "like"; `prefers?` alone would reject
   "the parser prefers UTF-8", and a bare "next time" would reject "the next time a pod boots". */
const NOT_A_GOTCHA: Array<{ pattern: RegExp; why: string }> = [
  {
    pattern:
      /\b(?:the\s+)?(?:user|users|team|client|reviewer|maintainer|they|he|she)\s+(?:prefers?|likes?|wants?|asked|requested|insists?)\b|\basked (?:me|us) to\b/i,
    why: "this reads as a preference someone stated, not something that surprised you",
  },
  {
    pattern: /^\s*(?:i|we)\s+(?:changed|added|updated|set|renamed|removed|fixed|created|refactored|bumped)\b/i,
    why: "this reads as a record of what you just did, not a durable constraint",
  },
  {
    pattern: /\btodo\b|\bwe should\b|\bremember to\b|\bdon'?t forget\b|\bnext time (?:we|you|i) (?:should|need|must)\b/i,
    why: "this reads as a plan or reminder, not knowledge about how the system behaves",
  },
];

function describe(gotcha: Gotcha): string {
  const scope = gotcha.paths.length ? scopeOf(gotcha) : "project-wide";
  return `${gotcha.id} — ${gotcha.summary} [${scope}]`;
}

async function findDuplicate(runtime: Runtime, summary: string, aliases: string[]): Promise<Gotcha | null> {
  const all = gotchas(runtime);
  if (!all.length) return null;
  const probe = [summary, aliases.join(" ")].join(" ");
  const index = byId(all);

  for (const gotcha of all) {
    if (jaccard(probe, `${gotcha.summary} ${gotcha.aliases.join(" ")}`) >= runtime.settings.duplicateOverlap) {
      return gotcha;
    }
  }

  const ranked = await hybridSearch(runtime, probe, 3);
  const top = ranked[0];
  if (top && (top.semantic ?? 0) >= runtime.settings.duplicateThreshold) return index.get(top.id) ?? null;
  return null;
}

// Today's writes first, because the most likely thing to drop is something recorded in the same
// burst of work; then whatever else the store says is closest to the new one.
async function replaceCandidates(runtime: Runtime, probe: string): Promise<Gotcha[]> {
  const all = gotchas(runtime);
  const index = byId(all);
  const today = runtime.ledger
    .writtenToday()
    .map((id) => index.get(id))
    .filter((gotcha): gotcha is Gotcha => Boolean(gotcha));

  const seen = new Set(today.map((gotcha) => gotcha.id));
  const ranked = (await hybridSearch(runtime, probe, 8))
    .map((entry) => index.get(entry.id))
    .filter((gotcha): gotcha is Gotcha => Boolean(gotcha) && !seen.has(gotcha.id));

  return [...today, ...ranked].slice(0, 8);
}

export interface ToolResult {
  text: string;
}

export interface ToolContext {
  // Present only where there is a human to ask. A background subagent has neither, so its
  // writes become proposals instead of spending budget nobody approved.
  ask?: (question: string, detail: string) => Promise<boolean>;
  choose?: (question: string, options: Array<{ label: string; value: string }>) => Promise<string | null>;
}

function refuseJunk(summary: string): string | null {
  for (const { pattern, why } of NOT_A_GOTCHA) {
    if (pattern.test(summary)) {
      return `Not recorded: ${why}. A gotcha is something that behaved differently from what you expected, and that would cost the next session the same investigation.`;
    }
  }
  return null;
}

export async function runGotchaTool(
  runtime: Runtime,
  params: Record<string, unknown>,
  context: ToolContext = {},
): Promise<ToolResult> {
  const action = String(params.action ?? "");
  const { store, ledger, settings } = runtime;

  if (action === "search") {
    const query = String(params.query ?? "").trim();
    if (!query) return { text: "search needs a query." };
    const limit = Number(params.limit) > 0 ? Number(params.limit) : 5;
    const ranked = prune(await hybridSearch(runtime, query, limit), settings.searchVeto);
    if (!ranked.length) return { text: "No gotchas recorded for that." };
    const index = byId(gotchas(runtime));
    const lines = ranked
      .map((entry) => index.get(entry.id))
      .filter((gotcha): gotcha is Gotcha => Boolean(gotcha))
      .map((gotcha) => describe(gotcha));
    const note = runtime.semantic.ready ? "" : "\n(meaning-based search unavailable; keyword results only)";
    return { text: `${lines.join("\n")}\n\nRead one with action "read".${note}` };
  }

  if (action === "read") {
    const id = String(params.id ?? "").trim();
    const gotcha = store.get(id);
    if (!gotcha) return { text: `No gotcha with id ${id}.` };

    const asked = Number(params.offset);
    const offset = Number.isFinite(asked) && asked > 0 ? Math.floor(asked) : 0;
    // Continuing a body the agent already chose to open is not a second decision to open it.
    if (offset === 0) {
      runtime.surfacer.withdraw(id);
      ledger.recordRead(id);
    }

    const slice = gotcha.body.slice(offset, offset + settings.readChunk);
    const remaining = Math.max(0, gotcha.body.length - (offset + slice.length));
    const more = remaining > 0 ? `\n\n…${remaining} more characters; read again with offset: ${offset + slice.length}` : "";

    if (offset > 0) return { text: `# ${gotcha.id} (from ${offset})\n\n${slice}${more}` };

    const scope = gotcha.paths.length ? gotcha.paths.join(", ") : "project-wide";
    return {
      text:
        [
          `# ${gotcha.id}`,
          gotcha.summary,
          ``,
          `Covers: ${scope}`,
          gotcha.trigger ? `Comes up when: ${gotcha.trigger}` : "",
          gotcha.aliases.length ? `Also known as: ${gotcha.aliases.join(", ")}` : "",
          `Expected: ${gotcha.expected}`,
          `Actually: ${gotcha.actual}`,
          `Updated: ${gotcha.updated}`,
          ``,
          slice,
        ]
          .filter((part) => part !== "")
          .join("\n") + more,
    };
  }

  if (action === "list") {
    const all = gotchas(runtime);
    if (!all.length) return { text: "No gotchas recorded yet." };
    const limit = Number(params.limit) > 0 ? Number(params.limit) : settings.listLimit;
    const shown = all.slice(0, limit).map(describe).join("\n");
    const rest = all.length - Math.min(limit, all.length);
    return { text: rest > 0 ? `${shown}\n…and ${rest} more; use search to find them.` : shown };
  }

  if (action === "add") {
    const summary = String(params.summary ?? "").trim();
    const expected = String(params.expected ?? "").trim();
    const actual = String(params.actual ?? "").trim();
    const trigger = String(params.trigger ?? "").trim();
    const aliases = Array.isArray(params.aliases) ? params.aliases.map(String).filter(Boolean) : [];
    const paths = Array.isArray(params.paths) ? params.paths.map(String).filter(Boolean) : [];
    const body = String(params.body ?? "");

    if (!summary) return { text: "add needs a summary." };
    if (summary.length > MAX_SUMMARY) {
      return { text: `Summary is ${summary.length} characters; keep it under ${MAX_SUMMARY}.` };
    }

    const junk = refuseJunk(summary);
    if (junk) return { text: junk };

    if (tokens(summary).size < settings.minSummaryWords) {
      return {
        text:
          "That summary is too vague to find again. State the specific thing that behaved " +
          "unexpectedly and what it causes, in one line.",
      };
    }

    if (body.length > settings.maxBodyChars) {
      return {
        text:
          `The body is ${body.length} characters; keep it under ${settings.maxBodyChars}. ` +
          "Record the constraint and the exact values that matter, and point at the file, test or " +
          "commit instead of pasting output into it.",
      };
    }

    if (expected.length < settings.minEvidence || actual.length < settings.minEvidence) {
      return {
        text:
          "add needs both `expected` (what you thought would happen) and `actual` (what happened " +
          "instead, and how you found out). If there is nothing to put in either, this is not a gotcha.",
      };
    }
    if (aliases.length < settings.requireAliases) {
      return {
        text:
          `add needs at least ${settings.requireAliases} aliases: other words someone might search ` +
          "for instead of your wording. Without them this will not be found again.",
      };
    }
    if (trigger.length < settings.minEvidence) {
      return {
        text:
          "add needs a `trigger`: the work someone will be doing when they next need this, as a " +
          'task rather than a fact — "chasing rows missing from a finance export". That is what ' +
          "makes it findable when it matters.",
      };
    }

    const duplicate = await findDuplicate(runtime, summary, aliases);
    if (duplicate) {
      return {
        text:
          `This looks like ${duplicate.id}: "${duplicate.summary}". ` +
          `Update that one (action "update", id "${duplicate.id}") rather than adding a near-copy.`,
      };
    }

    const draft: GotchaDraft = { summary, expected, actual, trigger, paths, aliases, body };
    const written = ledger.writesToday();
    const cap = ledger.capToday(settings.dailyWriteCap);
    const overBudget = written >= cap;
    const needsReview = settings.reviewWrites === "always" || (settings.reviewWrites === "over-budget" && overBudget);

    if (needsReview && !context.choose) {
      const proposed = store.propose(draft);
      return {
        text:
          `Proposed ${proposed.id} rather than recording it: ${overBudget ? "today's budget is spent" : "writes are reviewed here"} ` +
          "and there is no one to ask in this session. A human resolves it with /gotchas-proposals.",
      };
    }

    if (needsReview && context.choose) {
      const question = overBudget
        ? `Record a ${written + 1}th gotcha today? The budget is ${cap}.`
        : "Record this gotcha?";
      const picked = await context.choose(`${question}\n${summary}`, [
        { label: overBudget ? "Record it anyway" : "Record it", value: "record" },
        { label: "Replace an existing gotcha…", value: "replace" },
        { label: "Skip it", value: "skip" },
      ]);

      if (picked === null || picked === "skip") return { text: "Not recorded; the user skipped it." };

      if (picked === "replace") {
        const candidates = await replaceCandidates(runtime, `${summary} ${aliases.join(" ")}`);
        if (!candidates.length) return { text: "Nothing to replace; not recorded." };
        const todayIds = new Set(ledger.writtenToday());
        const chosen = await context.choose(
          "Which gotcha should this replace?",
          candidates.map((candidate) => ({
            label: `${candidate.id} — ${candidate.summary}${todayIds.has(candidate.id) ? " (today)" : ""}`,
            value: candidate.id,
          })),
        );
        if (!chosen) return { text: "Not recorded; no replacement chosen." };

        const created = store.add(draft);
        store.retire(chosen);
        ledger.recordRetired(chosen, `replaced by ${created.id}`);
        ledger.forget(chosen);
        // A replacement leaves the store the same size, so it does not spend budget.
        ledger.recordWrite(created.id, false);
        void refreshSemantic(runtime);
        return { text: `Recorded ${created.id} in place of ${chosen}, which is retired.` };
      }

      if (overBudget) ledger.recordOverride();
    }

    if (overBudget && !needsReview) {
      return {
        text:
          `${written} gotchas were already recorded today, which is the budget across all ` +
          "sessions and subagents. Updating an existing gotcha is always allowed and does not " +
          "spend budget, so prefer that. The user can raise today's budget with /gotchas-budget.",
      };
    }

    const created = store.add(draft);
    ledger.recordWrite(created.id);
    void refreshSemantic(runtime);
    const remaining = Math.max(0, cap - ledger.writesToday());
    return {
      text:
        `Recorded ${created.id}. ${remaining} more can be recorded today; updating existing ` +
        "gotchas is unlimited.",
    };
  }

  if (action === "update") {
    const id = String(params.id ?? "").trim();
    if (!store.get(id)) return { text: `No gotcha with id ${id}.` };
    const patch: Record<string, unknown> = {};
    if (typeof params.summary === "string") patch.summary = params.summary;
    if (typeof params.expected === "string") patch.expected = params.expected;
    if (typeof params.actual === "string") patch.actual = params.actual;
    if (typeof params.trigger === "string") patch.trigger = params.trigger;
    if (typeof params.body === "string") patch.body = params.body;
    if (Array.isArray(params.paths)) patch.paths = params.paths.map(String);
    if (Array.isArray(params.aliases)) patch.aliases = params.aliases.map(String);
    if (!Object.keys(patch).length) return { text: "update needs at least one field to change." };
    if (typeof patch.body === "string" && patch.body.length > settings.maxBodyChars) {
      return { text: `The body is ${patch.body.length} characters; keep it under ${settings.maxBodyChars}.` };
    }
    if (typeof patch.summary === "string") {
      if (patch.summary.length > MAX_SUMMARY) {
        return { text: `Summary is ${patch.summary.length} characters; keep it under ${MAX_SUMMARY}.` };
      }
      const junk = refuseJunk(patch.summary);
      if (junk) return { text: junk };
    }
    const updated = store.update(id, patch);
    void refreshSemantic(runtime);
    return { text: updated ? `Updated ${updated.id}.` : `Could not update ${id}.` };
  }

  if (action === "retire") {
    const id = String(params.id ?? "").trim();
    const reason = String(params.reason ?? "").trim();
    if (!reason) return { text: "retire needs a reason." };
    if (!store.get(id)) return { text: `No gotcha with id ${id}.` };
    store.retire(id);
    ledger.recordRetired(id, reason);
    ledger.forget(id);
    void refreshSemantic(runtime);
    return { text: `Retired ${id}. The reason is logged and git keeps the file history.` };
  }

  return { text: `Unknown action "${action}".` };
}
