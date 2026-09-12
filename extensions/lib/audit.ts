import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Ledger } from "./ledger.ts";
import { staleScopes } from "./paths.ts";
import { jaccard } from "./text.ts";
import type { Gotcha, GotchaStore } from "./store.ts";

export interface AuditReport {
  total: number;
  stale: Array<{ id: string; scopes: string[] }>;
  nearDuplicates: Array<{ a: string; b: string; overlap: number }>;
  thinEvidence: string[];
  noisy: Array<{ id: string; surfaced: number }>;
  oldest: Array<{ id: string; updated: string }>;
}

export function audit(store: GotchaStore, root: string, ledger?: Ledger, all = store.list()): AuditReport {
  const stale = all
    .map((gotcha) => ({ id: gotcha.id, scopes: staleScopes(gotcha, root) }))
    .filter((entry) => entry.scopes.length > 0);

  const nearDuplicates: AuditReport["nearDuplicates"] = [];
  for (let i = 0; i < all.length; i += 1) {
    for (let j = i + 1; j < all.length; j += 1) {
      const overlap = jaccard(
        `${all[i].summary} ${all[i].aliases.join(" ")}`,
        `${all[j].summary} ${all[j].aliases.join(" ")}`,
      );
      if (overlap >= 0.3) nearDuplicates.push({ a: all[i].id, b: all[j].id, overlap: Number(overlap.toFixed(2)) });
    }
  }

  return {
    total: all.length,
    stale,
    nearDuplicates: nearDuplicates.sort((x, y) => y.overlap - x.overlap).slice(0, 20),
    thinEvidence: all.filter((gotcha) => `${gotcha.expected} ${gotcha.actual}`.trim().length < 40).map((g) => g.id),
    noisy: ledger ? ledger.noise() : [],
    oldest: [...all]
      .sort((a, b) => (a.updated < b.updated ? -1 : 1))
      .slice(0, 10)
      .map((gotcha) => ({ id: gotcha.id, updated: gotcha.updated })),
  };
}

export function renderReport(report: AuditReport): string {
  const lines = [`${report.total} gotchas`];
  if (report.noisy.length) {
    lines.push(`${report.noisy.length} surfaced repeatedly but never opened:`);
    for (const entry of report.noisy) lines.push(`  ${entry.id}: surfaced ${entry.surfaced} times, read 0`);
  }
  if (report.stale.length) {
    lines.push(`${report.stale.length} with paths that no longer exist:`);
    for (const entry of report.stale) lines.push(`  ${entry.id}: ${entry.scopes.join(", ")}`);
  }
  if (report.nearDuplicates.length) {
    lines.push(`${report.nearDuplicates.length} near-duplicate pairs:`);
    for (const pair of report.nearDuplicates) lines.push(`  ${pair.a} ~ ${pair.b} (${pair.overlap})`);
  }
  if (report.thinEvidence.length) lines.push(`Thin evidence: ${report.thinEvidence.join(", ")}`);
  if (!report.noisy.length && !report.stale.length && !report.nearDuplicates.length && !report.thinEvidence.length) {
    lines.push("Nothing flagged.");
  }
  return lines.join("\n");
}

function gotchaBlock(gotcha: Gotcha, ledger?: Ledger): string {
  const scope = gotcha.paths.length ? gotcha.paths.join(", ") : "project-wide";
  const usage = ledger ? ledger.usage(gotcha.id) : { surfaced: 0, read: 0 };
  return [
    `### ${gotcha.id}`,
    `- summary: ${gotcha.summary}`,
    `- covers: ${scope}`,
    `- aliases: ${gotcha.aliases.join(", ") || "(none)"}`,
    `- expected: ${gotcha.expected || "(none)"}`,
    `- actual: ${gotcha.actual || "(none)"}`,
    `- updated: ${gotcha.updated}`,
    `- surfaced ${usage.surfaced} times, opened ${usage.read} times`,
  ].join("\n");
}

export const PROPOSALS_HEADING = "## Proposals";

export function auditPacket(store: GotchaStore, root: string, ledger?: Ledger): { path: string; text: string } {
  const all = store.list();
  const report = audit(store, root, ledger, all);
  const text = [
    `# Gotcha audit — ${new Date().toISOString().slice(0, 10)}`,
    ``,
    `Store: ${store.dir}`,
    ``,
    `## Automatic checks`,
    ``,
    renderReport(report),
    ``,
    `## The store`,
    ``,
    all.map((gotcha) => gotchaBlock(gotcha, ledger)).join("\n\n"),
    ``,
    PROPOSALS_HEADING,
    ``,
    `Write one proposal per line, in this exact form:`,
    ``,
    "```",
    `retire <id> — <why it is no longer worth keeping>`,
    `merge <keep-id> <- <drop-id> — <why they are the same thing>`,
    "```",
    ``,
    `Judge each gotcha against these rules:`,
    `- Would re-learning it cost a real investigation? If not, retire it.`,
    `- Does the code already say it, or a type, or a test name? If so, retire it.`,
    `- Is it a record of what someone did, or a preference they stated? Retire it.`,
    `- Has it surfaced many times and never been opened? That is the signature of noise: retire it`,
    `  unless the knowledge is plainly load-bearing.`,
    `- Do two of them describe the same underlying fact? Merge them.`,
    `- Is it now wrong, or about code that no longer exists? Retire it.`,
    `Keep anything you are unsure about; a human reviews this file before anything is applied.`,
    ``,
  ].join("\n");

  const path = join(store.ensureCacheDir(), `audit-${new Date().toISOString().slice(0, 10)}.md`);
  writeFileSync(path, text);
  return { path, text };
}

export type Proposal =
  | { kind: "retire"; id: string; reason: string }
  | { kind: "merge"; keep: string; drop: string; reason: string };

export function parseProposals(text: string): Proposal[] {
  const start = text.indexOf(PROPOSALS_HEADING);
  const body = start === -1 ? text : text.slice(start + PROPOSALS_HEADING.length);
  const out: Proposal[] = [];
  for (const raw of body.split("\n")) {
    const cleanLine = raw.replace(/^[-*]\s*(\[[ xX]\]\s*)?/, "").trim();
    const retire = /^retire\s+([\w.-]+)\s*(?:[—-]\s*(.*))?$/.exec(cleanLine);
    if (retire) {
      out.push({ kind: "retire", id: retire[1], reason: (retire[2] ?? "").trim() });
      continue;
    }
    const merge = /^merge\s+([\w.-]+)\s*<-\s*([\w.-]+)\s*(?:[—-]\s*(.*))?$/.exec(cleanLine);
    if (merge) out.push({ kind: "merge", keep: merge[1], drop: merge[2], reason: (merge[3] ?? "").trim() });
  }
  return out;
}

export function applyProposals(store: GotchaStore, proposals: Proposal[], ledger?: Ledger): string[] {
  const applied: string[] = [];
  for (const proposal of proposals) {
    if (proposal.kind === "retire") {
      const gone = store.retire(proposal.id);
      if (gone && ledger) {
        ledger.recordRetired(proposal.id, proposal.reason || "audit");
        ledger.forget(proposal.id);
      }
      applied.push(gone ? `retired ${proposal.id}` : `skipped ${proposal.id} (not found)`);
      continue;
    }
    const keep = store.get(proposal.keep);
    const drop = store.get(proposal.drop);
    if (!keep || !drop) {
      applied.push(`skipped merge ${proposal.keep} <- ${proposal.drop} (not found)`);
      continue;
    }
    store.update(keep.id, {
      paths: [...new Set([...keep.paths, ...drop.paths])],
      aliases: [...new Set([...keep.aliases, ...drop.aliases])],
      body: `${keep.body}\n\nMerged from ${drop.id}: ${drop.summary}\n\n${drop.body}`.trim(),
    });
    store.retire(drop.id);
    if (ledger) {
      ledger.recordRetired(drop.id, proposal.reason || `merged into ${keep.id}`);
      ledger.forget(drop.id);
    }
    applied.push(`merged ${drop.id} into ${keep.id}`);
  }
  return applied;
}
