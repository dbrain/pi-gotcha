import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { applyProposals, audit, auditPacket, parseProposals, renderReport } from "./lib/audit.ts";
import { matching, pathsIn, projectWide } from "./lib/paths.ts";
import { gate } from "./lib/rank.ts";
import { byId, createRuntime, gotchas, hybridSearch, refreshSemantic, type Runtime } from "./lib/runtime.ts";
import { overlaps } from "./lib/text.ts";
import { runGotchaTool, TOOL_DESCRIPTION, TOOL_PARAMETERS } from "./lib/tool.ts";

function deliver(pi: any, content: string): void {
  try {
    pi.sendMessage({ customType: "pi-gotcha", content, display: false }, { deliverAs: "nextTurn" });
  } catch {
    /* delivery is best effort: a dropped nudge must never fail the turn */
  }
}

function newestPacket(dir: string): string | null {
  if (!existsSync(dir)) return null;
  const packets = readdirSync(dir)
    .filter((name) => name.startsWith("audit-") && name.endsWith(".md"))
    .sort();
  return packets.length ? join(dir, packets[packets.length - 1]) : null;
}

export default function (pi: any): void {
  let runtime: Runtime | null = null;

  const ready = (ctx: any): Runtime => {
    const root: string = ctx?.cwd ?? process.cwd();
    if (!runtime || runtime.root !== root) runtime = createRuntime(root);
    return runtime;
  };

  pi.on("tool_call", (event: any, ctx: any) => {
    const active = ready(ctx);
    if (!active.settings.surface || !active.store.exists()) return;
    const touched = pathsIn(event?.input, active.root);
    if (!touched.length) return;
    active.surfacer.stage(matching(gotchas(active), touched, active.settings.maxPathSurfacedPerTurn));
  });

  pi.on("before_agent_start", async (event: any, ctx: any) => {
    const active = ready(ctx);
    if (!active.settings.surface || active.settings.maxSurfacedPerTurn === 0) return;
    if (!active.store.exists()) return;
    const prompt = String(event?.prompt ?? "").trim();
    if (!prompt) return;

    const wide = projectWide(gotchas(active));
    if (!wide.length) return;

    const allowed = new Set(wide.map((gotcha) => gotcha.id));
    const ranked = (await hybridSearch(active, prompt, 10)).filter((entry) => allowed.has(entry.id));
    const decision = gate(ranked, {
      standout: active.settings.standout,
      semanticFloor: active.settings.semanticFloor,
      cap: active.settings.maxSurfacedPerTurn,
    });
    if (!decision.surfaced.length) return;

    const index = byId(wide);
    const chosen = decision.surfaced
      .map((entry) => index.get(entry.id))
      .filter((gotcha): gotcha is NonNullable<typeof gotcha> => Boolean(gotcha))
      // A lone candidate stands out from nothing, so the ratio alone would push it. Without
      // embeddings nothing measures meaning, so require at least one shared word before
      // spending context on something the user did not ask for.
      .filter(
        (gotcha) =>
          active.semantic.ready || overlaps(prompt, `${gotcha.summary} ${gotcha.aliases.join(" ")}`),
      );
    if (chosen.length) active.surfacer.stage(chosen);
  });

  pi.on("agent_settled", (_event: unknown, ctx: any) => {
    const active = ready(ctx);
    const flushed = active.surfacer.flush();
    if (!flushed) return;
    active.ledger.recordSurfaced(flushed.ids);
    deliver(pi, flushed.text);
  });

  pi.on("session_compact", (_event: unknown, ctx: any) => {
    ready(ctx).surfacer.resetSeen();
  });

  pi.registerTool({
    name: "gotcha",
    label: "Gotcha",
    description: TOOL_DESCRIPTION,
    parameters: TOOL_PARAMETERS,
    async execute(_toolCallId: string, params: Record<string, unknown>, _signal: unknown, _onUpdate: unknown, ctx: any) {
      const ask =
        typeof ctx?.ui?.confirm === "function"
          ? (question: string, detail: string) => ctx.ui.confirm(question, detail)
          : undefined;
      const result = await runGotchaTool(ready(ctx), params, { ask });
      return { content: [{ type: "text", text: result.text }], details: {} };
    },
  });

  pi.registerCommand("gotchas", {
    description: "List recorded gotchas and store status",
    handler: async (_args: string, ctx: any) => {
      const active = ready(ctx);
      const all = gotchas(active);
      if (!all.length) {
        ctx.ui.notify(`No gotchas in ${active.store.dir}`, "info");
        return;
      }
      const semantic = active.semantic.ready
        ? "meaning-based search ready"
        : `keyword only${active.semantic.failure ? `: ${active.semantic.failure}` : ""}`;
      const overrides = active.ledger.overridesToday();
      ctx.ui.notify(
        [
          `${all.length} gotchas in ${active.store.dir} (${semantic})`,
          `Recorded today: ${active.ledger.writesToday()} of ${active.ledger.capToday(active.settings.dailyWriteCap)}` +
            (overrides ? ` (${overrides} approved over budget)` : ""),
          `Surfaced this session: ${active.surfacer.seenCount()}`,
        ].join("\n"),
        "info",
      );
    },
  });

  pi.registerCommand("gotchas-budget", {
    description: "Show or raise today's gotcha write budget",
    handler: async (args: string, ctx: any) => {
      const active = ready(ctx);
      const used = active.ledger.writesToday();
      const wanted = args.trim();
      if (!wanted) {
        ctx.ui.notify(
          `Recorded ${used} of ${active.ledger.capToday(active.settings.dailyWriteCap)} today. ` +
            "Raise it with /gotchas-budget <n>; updating existing gotchas is always unlimited.",
          "info",
        );
        return;
      }
      const cap = Number(wanted);
      if (!Number.isFinite(cap) || cap < 0) {
        ctx.ui.notify("Usage: /gotchas-budget <number>", "warning");
        return;
      }
      active.ledger.raiseToday(Math.floor(cap));
      ctx.ui.notify(`Today's budget is now ${Math.floor(cap)}; ${used} already recorded.`, "info");
    },
  });

  pi.registerCommand("gotchas-review", {
    description: "Show noisy, stale, duplicated and thin gotchas for human review",
    handler: async (_args: string, ctx: any) => {
      const active = ready(ctx);
      ctx.ui.notify(renderReport(audit(active.store, active.root, active.ledger)), "info");
    },
  });

  pi.registerCommand("gotchas-audit", {
    description: "Write an audit packet and ask the agent to review the store with a subagent",
    handler: async (_args: string, ctx: any) => {
      const active = ready(ctx);
      if (!gotchas(active).length) {
        ctx.ui.notify("No gotchas to audit.", "info");
        return;
      }
      const packet = auditPacket(active.store, active.root, active.ledger);
      ctx.ui.notify(`Audit packet written to ${packet.path}`, "info");
      deliver(
        pi,
        [
          `A gotcha audit packet is at ${packet.path}.`,
          `Delegate the review to a subagent: have it read that file, judge each gotcha against the`,
          `rules in it, and append its proposals under the "## Proposals" heading of the same file.`,
          `It must not edit the store itself.`,
          `Then tell the user to review the file and run /gotchas-apply to apply what they keep.`,
        ].join("\n"),
      );
    },
  });

  pi.registerCommand("gotchas-apply", {
    description: "Apply retire/merge proposals from an audit packet (defaults to the newest)",
    handler: async (args: string, ctx: any) => {
      const active = ready(ctx);
      const target = args.trim();
      const path = target
        ? isAbsolute(target)
          ? target
          : join(active.root, target)
        : newestPacket(active.store.cacheDir);
      if (!path || !existsSync(path)) {
        ctx.ui.notify(target ? `No such file: ${path}` : "No audit packet found; run /gotchas-audit first.", "warning");
        return;
      }
      const proposals = parseProposals(readFileSync(path, "utf8"));
      if (!proposals.length) {
        ctx.ui.notify(`No proposals found in ${path}.`, "info");
        return;
      }
      const confirmed = await ctx.ui.confirm(
        "Apply gotcha proposals?",
        `${proposals.length} proposals from ${path}. Files are deleted; git keeps the history.`,
      );
      if (!confirmed) return;
      const applied = applyProposals(active.store, proposals, active.ledger);
      void refreshSemantic(active);
      ctx.ui.notify(applied.join("\n"), "info");
    },
  });
}
