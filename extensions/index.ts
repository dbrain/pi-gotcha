import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { applyProposals, audit, auditPacket, parseProposals, renderReport, writeIndex } from "./lib/audit.ts";
import { debugLog } from "./lib/debug.ts";
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

  // Every store-scoped command takes an optional leading "user" argument; the default is the
  // project store, so existing muscle memory and scripts keep working.
  const storeFor = (active: Runtime, args: string) => {
    const scope = args.trim().split(/\s+/)[0] === "user" ? "user" : "project";
    return scope === "user"
      ? { scope, store: active.userStore, ledger: active.userLedger }
      : { scope, store: active.store, ledger: active.ledger };
  };

  pi.on("tool_call", (event: any, ctx: any) => {
    const active = ready(ctx);
    if (!active.settings.surface || !active.store.exists()) return;
    const touched = pathsIn(event?.input, active.root);
    if (!touched.length) return;
    const matched = matching(gotchas(active), touched, active.settings.maxPathSurfacedPerTurn);
    if (matched.length) {
      debugLog("tool_call", {
        root: active.root,
        signature: active.store.signature(),
        touched,
        matched: matched.map((gotcha) => ({ id: gotcha.id, summary: gotcha.summary.slice(0, 30) })),
      });
    }
    active.surfacer.stage(matched);
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
    // A gotcha can be retired or corrected between staging and delivery (the 2026-09-13 incident
    // delivered a line for a fact deleted 51 minutes earlier). Re-read the store and re-render
    // from the current object, so a line is never delivered for a fact that is gone or changed.
    const live = byId(gotchas(active));
    const flushed = active.surfacer.flush((id) => live.get(id));
    if (!flushed) return;
    active.ledger.recordSurfaced(flushed.ids);
    // The last word before the text enters pi core's delivery queue: if this log shows S2 and
    // the session log shows S1, the substitution happened in pi core, not here.
    debugLog("deliver", { root: active.root, signature: active.store.signature(), text: flushed.text });
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
      const choose =
        typeof ctx?.ui?.select === "function"
          ? async (question: string, options: Array<{ label: string; value: string }>) => {
              const picked = await ctx.ui.select(question, options.map((option) => option.label));
              return picked ? (options.find((option) => option.label === picked)?.value ?? null) : null;
            }
          : undefined;
      const result = await runGotchaTool(ready(ctx), params, { ask, choose });
      return { content: [{ type: "text", text: result.text }], details: {} };
    },
  });

  pi.registerCommand("gotchas", {
    description: "List recorded gotchas and store status",
    handler: async (_args: string, ctx: any) => {
      const active = ready(ctx);
      const all = gotchas(active);
      const userCount = active.userStore.list().length;
      if (!all.length) {
        ctx.ui.notify(
          userCount ? `No project gotchas; ${userCount} in the user store (${active.userStore.dir})` : `No gotchas in ${active.store.dir}`,
          "info",
        );
        return;
      }
      const semantic = active.semantic.ready
        ? "meaning-based search ready"
        : `keyword only${active.semantic.failure ? `: ${active.semantic.failure}` : ""}`;
      const overrides = active.ledger.overridesToday();
      const pending = active.store.proposals().length;
      ctx.ui.notify(
        [
          `${all.length} gotchas in ${active.store.dir} (${semantic})${userCount ? `; ${userCount} in the user store` : ""}`,
          ...(pending ? [`${pending} proposed, waiting for /gotchas-proposals`] : []),
          `Recorded today: ${active.ledger.writesToday()} of ${active.ledger.capToday(active.settings.dailyWriteCap)}` +
            (overrides ? ` (${overrides} approved over budget)` : ""),
          `Surfaced this session: ${active.surfacer.seenCount()}`,
        ].join("\n"),
        "info",
      );
    },
  });

  pi.registerCommand("gotchas-proposals", {
    description: "Resolve gotchas proposed by subagents: accept, reject, or replace an existing one (add 'user' for the user store)",
    handler: async (args: string, ctx: any) => {
      const active = ready(ctx);
      const { store, ledger } = storeFor(active, args);
      const proposals = store.proposals();
      if (!proposals.length) {
        ctx.ui.notify("No proposals pending.", "info");
        return;
      }

      const done: string[] = [];
      for (const proposal of proposals) {
        const scope = proposal.paths.length ? proposal.paths.join(", ") : "project-wide";
        const picked = await ctx.ui.select(
          `${proposal.summary}\n[${scope}] expected: ${proposal.expected} / actually: ${proposal.actual}`,
          ["Accept", "Reject", "Replace an existing gotcha…", "Leave for later"],
        );
        if (!picked || picked === "Leave for later") break;

        if (picked === "Accept") {
          const accepted = store.acceptProposal(proposal.id);
          if (accepted) ledger.recordWrite(accepted.id, false);
          done.push(`accepted ${proposal.id}`);
          continue;
        }
        if (picked === "Reject") {
          store.rejectProposal(proposal.id);
          done.push(`rejected ${proposal.id}`);
          continue;
        }

        const existing = store.list();
        if (!existing.length) {
          done.push(`nothing to replace for ${proposal.id}`);
          continue;
        }
        const target = await ctx.ui.select(
          `Which gotcha should ${proposal.id} replace?`,
          existing.map((gotcha) => `${gotcha.id} — ${gotcha.summary}`),
        );
        if (!target) continue;
        const targetId = String(target).split(" — ")[0];
        store.retire(targetId);
        ledger.recordRetired(targetId, `replaced by ${proposal.id}`);
        ledger.forget(targetId);
        store.acceptProposal(proposal.id);
        ledger.recordWrite(proposal.id, false);
        done.push(`${proposal.id} replaced ${targetId}`);
      }

      void refreshSemantic(active);
      ctx.ui.notify(done.length ? done.join("\n") : "Nothing resolved.", "info");
    },
  });

  pi.registerCommand("gotchas-index", {
    description: "Write a browsable index of every gotcha, grouped by what it covers (add 'user' for the user store)",
    handler: async (args: string, ctx: any) => {
      const active = ready(ctx);
      const { store, ledger } = storeFor(active, args);
      if (!store.list().length) {
        ctx.ui.notify("No gotchas to index.", "info");
        return;
      }
      const written = writeIndex(store, ledger);
      ctx.ui.notify(`Indexed ${written.count} gotchas to ${written.path}`, "info");
    },
  });

  pi.registerCommand("gotchas-budget", {
    description: "Show or raise today's gotcha write budget (add 'user' for the user store)",
    handler: async (args: string, ctx: any) => {
      const active = ready(ctx);
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const { store, ledger } = storeFor(active, args);
      const wanted = tokens[0] === "user" ? tokens[1] : tokens[0];
      const used = ledger.writesToday();
      if (!wanted) {
        ctx.ui.notify(
          `Recorded ${used} of ${ledger.capToday(active.settings.dailyWriteCap)} today ` +
            `(store: ${store.dir}). ` +
            "Raise it with /gotchas-budget <n>; updating existing gotchas is always unlimited.",
          "info",
        );
        return;
      }
      const cap = Number(wanted);
      if (!Number.isFinite(cap) || cap < 0) {
        ctx.ui.notify("Usage: /gotchas-budget [user] <number>", "warning");
        return;
      }
      ledger.raiseToday(Math.floor(cap));
      ctx.ui.notify(`Today's budget is now ${Math.floor(cap)}; ${used} already recorded.`, "info");
    },
  });

  pi.registerCommand("gotchas-review", {
    description: "Show noisy, stale, duplicated and thin gotchas for human review (add 'user' for the user store)",
    handler: async (args: string, ctx: any) => {
      const active = ready(ctx);
      const { store, ledger } = storeFor(active, args);
      ctx.ui.notify(renderReport(audit(store, active.root, ledger)), "info");
    },
  });

  pi.registerCommand("gotchas-audit", {
    description: "Write an audit packet and ask the agent to review the store with a subagent (add 'user' for the user store)",
    handler: async (args: string, ctx: any) => {
      const active = ready(ctx);
      const { store, ledger } = storeFor(active, args);
      if (!store.list().length) {
        ctx.ui.notify("No gotchas to audit.", "info");
        return;
      }
      const packet = auditPacket(store, active.root, ledger);
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
    description: "Apply retire/merge proposals from an audit packet (defaults to the newest; add 'user' for the user store)",
    handler: async (args: string, ctx: any) => {
      const active = ready(ctx);
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const { store, ledger } = storeFor(active, args);
      const target = tokens[0] === "user" ? tokens[1] : tokens[0];
      const path = target
        ? isAbsolute(target)
          ? target
          : join(active.root, target)
        : newestPacket(store.cacheDir);
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
      const applied = applyProposals(store, proposals, ledger);
      void refreshSemantic(active);
      ctx.ui.notify(applied.join("\n"), "info");
    },
  });
}
