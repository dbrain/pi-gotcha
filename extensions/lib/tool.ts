import { MAX_SUMMARY, type Gotcha } from "./store.ts";
import { prune } from "./rank.ts";
import { jaccard } from "./text.ts";
import { byId, gotchas, hybridSearch, refreshSemantic, type Runtime } from "./runtime.ts";

export const MIN_EVIDENCE = 15;

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
    evidence: {
      type: "string",
      description: "add, update: what you expected, what actually happened, and how you found out.",
    },
    paths: {
      type: "array",
      items: { type: "string" },
      description:
        "add, update: files or directories this covers, repo-relative; end a directory with '/'. " +
        "Omit only for knowledge that is not tied to any path.",
    },
    aliases: {
      type: "array",
      items: { type: "string" },
      description:
        "add, update: other words someone might search for instead of your wording. This is what " +
        "makes the gotcha findable later; give 2-5.",
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
  "add one ONLY when you learned something that would cost the next session the same investigation: " +
  "a silent failure, an undocumented constraint, a value that must match something elsewhere. " +
  "Do NOT add what the code already shows, what a type says, what you just did, or what worked as " +
  "documented. If the knowledge belongs at one line of code, write a comment there instead. " +
  "Prefer update over add: a near-duplicate is refused. retire one when you find it is wrong.";

function describe(gotcha: Gotcha): string {
  const scope = gotcha.paths.length ? gotcha.paths.join(", ") : "project-wide";
  return `${gotcha.id} — ${gotcha.summary} [${scope}]`;
}

async function findDuplicate(runtime: Runtime, summary: string, aliases: string[]): Promise<Gotcha | null> {
  const all = gotchas(runtime);
  if (!all.length) return null;
  const probe = [summary, aliases.join(" ")].join(" ");
  const index = byId(all);

  for (const gotcha of all) {
    if (jaccard(probe, `${gotcha.summary} ${gotcha.aliases.join(" ")}`) >= 0.5) return gotcha;
  }

  const ranked = await hybridSearch(runtime, probe, 3);
  const top = ranked[0];
  if (top && (top.semantic ?? 0) >= runtime.settings.duplicateThreshold) return index.get(top.id) ?? null;
  return null;
}

export interface ToolResult {
  text: string;
}

export async function runGotchaTool(runtime: Runtime, params: Record<string, unknown>): Promise<ToolResult> {
  const action = String(params.action ?? "");
  const store = runtime.store;

  if (action === "search") {
    const query = String(params.query ?? "").trim();
    if (!query) return { text: "search needs a query." };
    const limit = Number(params.limit) > 0 ? Number(params.limit) : 5;
    const ranked = prune(await hybridSearch(runtime, query, limit), runtime.settings.searchVeto);
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
    const scope = gotcha.paths.length ? gotcha.paths.join(", ") : "project-wide";
    return {
      text: [
        `# ${gotcha.id}`,
        `${gotcha.summary}`,
        ``,
        `Covers: ${scope}`,
        gotcha.aliases.length ? `Also known as: ${gotcha.aliases.join(", ")}` : "",
        `Evidence: ${gotcha.evidence}`,
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
    const limit = Number(params.limit) > 0 ? Number(params.limit) : all.length;
    return { text: all.slice(0, limit).map(describe).join("\n") };
  }

  if (action === "add") {
    const summary = String(params.summary ?? "").trim();
    const evidence = String(params.evidence ?? "").trim();
    const aliases = Array.isArray(params.aliases) ? params.aliases.map(String) : [];
    const paths = Array.isArray(params.paths) ? params.paths.map(String) : [];

    if (!summary) return { text: "add needs a summary." };
    if (summary.length > MAX_SUMMARY) {
      return { text: `Summary is ${summary.length} characters; keep it under ${MAX_SUMMARY}.` };
    }
    if (evidence.length < MIN_EVIDENCE) {
      return {
        text:
          "add needs evidence: what you expected, what actually happened, and how you found out. " +
          "If there is nothing to put there, this is not a gotcha.",
      };
    }
    if (runtime.session.writes >= runtime.settings.sessionWriteCap) {
      return {
        text:
          `Already recorded ${runtime.session.writes} gotchas this session, which is the cap. ` +
          "Update an existing one instead, or keep this for a session where it is the main finding.",
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

    const created = store.add({ summary, evidence, paths, aliases, body: String(params.body ?? "") });
    runtime.session.writes += 1;
    void refreshSemantic(runtime);
    return { text: `Recorded ${created.id}.` };
  }

  if (action === "update") {
    const id = String(params.id ?? "").trim();
    if (!store.get(id)) return { text: `No gotcha with id ${id}.` };
    const patch: Record<string, unknown> = {};
    if (typeof params.summary === "string") patch.summary = params.summary;
    if (typeof params.evidence === "string") patch.evidence = params.evidence;
    if (typeof params.body === "string") patch.body = params.body;
    if (Array.isArray(params.paths)) patch.paths = params.paths.map(String);
    if (Array.isArray(params.aliases)) patch.aliases = params.aliases.map(String);
    if (!Object.keys(patch).length) return { text: "update needs at least one field to change." };
    if (typeof patch.summary === "string" && patch.summary.length > MAX_SUMMARY) {
      return { text: `Summary is ${patch.summary.length} characters; keep it under ${MAX_SUMMARY}.` };
    }
    const updated = store.update(id, patch);
    void refreshSemantic(runtime);
    return { text: updated ? `Updated ${updated.id}.` : `Could not update ${id}.` };
  }

  if (action === "retire") {
    const id = String(params.id ?? "").trim();
    const reason = String(params.reason ?? "").trim();
    if (!reason) return { text: "retire needs a reason." };
    const gone = store.retire(id);
    if (gone) void refreshSemantic(runtime);
    return { text: gone ? `Retired ${id}. Reason recorded in this conversation; git keeps the file history.` : `No gotcha with id ${id}.` };
  }

  return { text: `Unknown action "${action}".` };
}
