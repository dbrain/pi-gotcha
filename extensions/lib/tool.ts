import { prune } from "./rank.ts";
import { byId, gotchas, hybridSearch, refreshSemantic, type Runtime } from "./runtime.ts";
import { scopeOf } from "./surfacing.ts";
import { jaccard } from "./text.ts";
import { MAX_SUMMARY, type Gotcha } from "./store.ts";

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
  },
  required: ["action"],
} as const;

export const TOOL_DESCRIPTION =
  "Hard-won project knowledge: things that cost real investigation and that reading the code does " +
  "not tell you. search it when you hit surprising behaviour or start work in an unfamiliar area; " +
  "relevant gotchas also arrive unasked when you touch the files they cover. " +
  "add one ONLY when something surprised you and would surprise the next session the same way: " +
  "a silent failure, an undocumented constraint, a value that must match something elsewhere. " +
  "Every add states what you expected and what actually happened; if you cannot fill both in, it " +
  "is not a gotcha. Do NOT record what the code shows, what a type says, what you just did, a " +
  "preference you were told, or something that worked as documented. If the knowledge belongs at " +
  "one line of code, write a comment there instead. Prefer update over add: a near-duplicate is " +
  "refused. retire one when you find it is wrong.";

/* A record of what someone did, or was told to prefer, is the commonest kind of junk a memory
   store fills with, and it is recognisable from the wording alone. Cheaper to refuse here
   than to ask a human to clean it up later. */
const NOT_A_GOTCHA: Array<{ pattern: RegExp; why: string }> = [
  {
    pattern: /\b(prefers?|likes?|wants?|asked (?:me|us) to|requested)\b/i,
    why: "this reads as a preference someone stated, not something that surprised you",
  },
  {
    pattern: /^\s*(?:i|we)\s+(?:changed|added|updated|set|renamed|removed|fixed|created|refactored|bumped)\b/i,
    why: "this reads as a record of what you just did, not a durable constraint",
  },
  {
    pattern: /\b(?:todo|next time|we should|remember to|don't forget)\b/i,
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

export interface ToolResult {
  text: string;
}

export interface ToolContext {
  // Present only where there is a human to ask: a background subagent gets no prompt, and so
  // cannot spend budget the user did not approve.
  ask?: (question: string, detail: string) => Promise<boolean>;
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
    runtime.surfacer.withdraw(id);
    ledger.recordRead(id);
    const scope = gotcha.paths.length ? gotcha.paths.join(", ") : "project-wide";
    return {
      text: [
        `# ${gotcha.id}`,
        gotcha.summary,
        ``,
        `Covers: ${scope}`,
        gotcha.aliases.length ? `Also known as: ${gotcha.aliases.join(", ")}` : "",
        `Expected: ${gotcha.expected}`,
        `Actually: ${gotcha.actual}`,
        `Updated: ${gotcha.updated}`,
        ``,
        gotcha.body,
      ]
        .filter((part) => part !== "")
        .join("\n"),
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
    const aliases = Array.isArray(params.aliases) ? params.aliases.map(String).filter(Boolean) : [];
    const paths = Array.isArray(params.paths) ? params.paths.map(String).filter(Boolean) : [];

    if (!summary) return { text: "add needs a summary." };
    if (summary.length > MAX_SUMMARY) {
      return { text: `Summary is ${summary.length} characters; keep it under ${MAX_SUMMARY}.` };
    }

    const junk = refuseJunk(summary);
    if (junk) return { text: junk };

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

    const written = ledger.writesToday();
    const cap = ledger.capToday(settings.dailyWriteCap);
    if (written >= cap) {
      const approved =
        settings.overBudgetPrompt && context.ask
          ? await context.ask(`Record a ${written + 1}th gotcha today? The budget is ${cap}.`, summary)
          : false;
      if (!approved) {
        return {
          text:
            `${written} gotchas were already recorded today, which is the budget across all ` +
            "sessions and subagents. Updating an existing gotcha is always allowed and does not " +
            "spend budget, so prefer that. The user can raise today's budget with /gotchas-budget.",
        };
      }
      ledger.recordOverride();
    }

    const duplicate = await findDuplicate(runtime, summary, aliases);
    if (duplicate) {
      return {
        text:
          `This looks like ${duplicate.id}: "${duplicate.summary}". ` +
          `Update that one (action "update", id "${duplicate.id}") rather than adding a near-copy.`,
      };
    }

    const created = store.add({ summary, expected, actual, paths, aliases, body: String(params.body ?? "") });
    ledger.recordWrite();
    void refreshSemantic(runtime);
    const remaining = Math.max(0, cap - written - 1);
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
    if (typeof params.body === "string") patch.body = params.body;
    if (Array.isArray(params.paths)) patch.paths = params.paths.map(String);
    if (Array.isArray(params.aliases)) patch.aliases = params.aliases.map(String);
    if (!Object.keys(patch).length) return { text: "update needs at least one field to change." };
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
