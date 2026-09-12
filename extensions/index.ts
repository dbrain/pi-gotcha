import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { applyProposals, audit, auditPacket, parseProposals, renderReport } from "./lib/audit.ts";
import { matching, pathsIn, projectWide } from "./lib/paths.ts";
import { gate } from "./lib/rank.ts";
import { byId, createRuntime, gotchas, hybridSearch, refreshSemantic, type Runtime } from "./lib/runtime.ts";
import { loadSettings } from "./lib/settings.ts";
import { runGotchaTool, TOOL_DESCRIPTION, TOOL_PARAMETERS } from "./lib/tool.ts";

function deliver(pi: any, content: string): void {
  try {
    pi.sendMessage({ customType: "pi-gotcha", content, display: false }, { deliverAs: "nextTurn" });
  } catch {
    /* delivery is best effort: a dropped nudge must never fail the turn */
  }
}

export default function (pi: any): void {
  const settings = loadSettings();
  let runtime: Runtime | null = null;

  const ready = (ctx: any): Runtime => {
    const root: string = ctx?.cwd ?? process.cwd();
    if (!runtime || runtime.root !== root) runtime = createRuntime(root, settings);
    return runtime;
  };

  pi.on("session_start", async (_event: unknown, ctx: any) => {
    const active = ready(ctx);
    if (!active.store.exists()) return;
    gotchas(active);
    void refreshSemantic(active);
  });

  pi.on("tool_call", (event: any, ctx: any) => {
    if (!settings.surface) return;
    const active = ready(ctx);
    if (!active.store.exists()) return;
    const touched = pathsIn(event?.input, active.root);
    if (!touched.length) return;
    active.surfacer.stage(matching(gotchas(active), touched));
  });

  pi.on("before_agent_start", async (event: any, ctx: any) => {
    if (!settings.surface || settings.maxSurfacedPerTurn === 0) return;
    const active = ready(ctx);
    if (!active.store.exists()) return;
    const prompt = String(event?.prompt ?? "").trim();
    if (!prompt) return;

    const wide = projectWide(gotchas(active));
    if (!wide.length) return;

    const allowed = new Set(wide.map((gotcha) => gotcha.id));
    const ranked = (await hybridSearch(active, prompt, 10)).filter((entry) => allowed.has(entry.id));
    const decision = gate(ranked, {
      standout: settings.standout,
      semanticFloor: settings.semanticFloor,
      cap: settings.maxSurfacedPerTurn,
    });
    if (!decision.surfaced.length) return;

    const index = byId(wide);
    active.surfacer.stage(decision.surfaced.map((entry) => index.get(entry.id)!).filter(Boolean));
  });

  pi.on("agent_settled", (_event: unknown, ctx: any) => {
    const active = ready(ctx);
    const text = active.surfacer.flush();
    if (text) deliver(pi, text);
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
      const result = await runGotchaTool(ready(ctx), params);
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
      ctx.ui.notify(
        `${all.length} gotchas in ${active.store.dir} (${semantic}); surfaced this session: ${active.surfacer.seenCount()}`,
        "info",
      );
    },
  });

  pi.registerCommand("gotchas-review", {
    description: "Show stale, duplicated and thin gotchas for human review",
    handler: async (_args: string, ctx: any) => {
      const active = ready(ctx);
      ctx.ui.notify(renderReport(audit(active.store, active.root)), "info");
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
      const packet = auditPacket(active.store, active.root);
      ctx.ui.notify(`Audit packet written to ${packet.path}`, "info");
      deliver(
        pi,
        [
          `A gotcha audit packet is at ${packet.path}.`,
          `Delegate the review to a subagent: have it read that file, judge each gotcha against the rules in it,`,
          `and append its proposals under the "${"## Proposals"}" heading of the same file. It must not edit the store itself.`,
          `Then tell the user to review the file and run /gotchas-apply ${packet.path} to apply what they keep.`,
        ].join("\n"),
      );
    },
  });

  pi.registerCommand("gotchas-apply", {
    description: "Apply retire/merge proposals from an audit packet",
    handler: async (args: string, ctx: any) => {
      const active = ready(ctx);
      const target = args.trim();
      if (!target) {
        ctx.ui.notify("Usage: /gotchas-apply <audit-file>", "warning");
        return;
      }
      const path = isAbsolute(target) ? target : join(active.root, target);
      if (!existsSync(path)) {
        ctx.ui.notify(`No such file: ${path}`, "warning");
        return;
      }
      const proposals = parseProposals(readFileSync(path, "utf8"));
      if (!proposals.length) {
        ctx.ui.notify("No proposals found in that file.", "info");
        return;
      }
      const confirmed = await ctx.ui.confirm(
        "Apply gotcha proposals?",
        `${proposals.length} proposals from ${path}. Files are deleted; git keeps the history.`,
      );
      if (!confirmed) return;
      const applied = applyProposals(active.store, proposals);
      void refreshSemantic(active);
      ctx.ui.notify(applied.join("\n"), "info");
    },
  });
}
