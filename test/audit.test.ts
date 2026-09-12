import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import {
  applyProposals,
  audit,
  auditPacket,
  parseProposals,
  PROPOSALS_HEADING,
  writeIndex,
} from "../extensions/lib/audit.ts";
import { Ledger } from "../extensions/lib/ledger.ts";
import { GotchaStore } from "../extensions/lib/store.ts";
import { cleanup, tempRoot } from "./helpers.ts";

const roots: string[] = [];
function project(): string {
  const root = tempRoot();
  roots.push(root);
  mkdirSync(join(root, "src", "billing"), { recursive: true });
  return root;
}

after(() => roots.forEach(cleanup));

const BILLING = {
  summary: "Invoice totals are integer cents; the CSV export drops any line with a comma",
  expected: "The export to contain the formatted total like every other column",
  actual: "The row vanished with no error at all, silently, in the finance parser",
  paths: ["src/billing/"],
  aliases: ["money", "currency"],
  body: "Detail about cents.",
};

describe("audit", () => {
  test("flags paths that no longer exist", () => {
    const root = project();
    const store = new GotchaStore(root);
    store.add(BILLING);
    store.add({ ...BILLING, summary: "Deleted module is still referenced by the loader", paths: ["src/gone/"] });
    const report = audit(store, root);
    assert.equal(report.stale.length, 1);
    assert.deepEqual(report.stale[0].scopes, ["src/gone/"]);
  });

  test("flags near-duplicate pairs", () => {
    const root = project();
    const store = new GotchaStore(root);
    store.add(BILLING);
    store.add({ ...BILLING, summary: "Invoice totals are integer cents and CSV export drops comma lines" });
    assert.equal(audit(store, root).nearDuplicates.length, 1);
  });

  test("flags thin evidence", () => {
    const root = project();
    const store = new GotchaStore(root);
    store.add({ summary: "Something odd happens sometimes", expected: "ok", actual: "not ok" });
    assert.equal(audit(store, root).thinEvidence.length, 1);
  });

  test("flags what surfaces constantly and is never opened", () => {
    const root = project();
    const store = new GotchaStore(root);
    const written = store.add(BILLING);
    const ledger = new Ledger(store);
    for (let i = 0; i < 6; i += 1) ledger.recordSurfaced([written.id]);
    assert.deepEqual(audit(store, root, ledger).noisy, [{ id: written.id, surfaced: 6 }]);
  });

  test("a clean store flags nothing", () => {
    const root = project();
    const store = new GotchaStore(root);
    store.add(BILLING);
    const report = audit(store, root, new Ledger(store));
    assert.deepEqual(
      [report.stale.length, report.nearDuplicates.length, report.thinEvidence.length, report.noisy.length],
      [0, 0, 0, 0],
    );
  });
});

describe("audit packet", () => {
  test("carries every gotcha, its usage, and the judging rules", () => {
    const root = project();
    const store = new GotchaStore(root);
    const a = store.add(BILLING);
    const ledger = new Ledger(store);
    ledger.recordSurfaced([a.id]);
    const text = readFileSync(auditPacket(store, root, ledger).path, "utf8");
    assert.match(text, new RegExp(`### ${a.id}`));
    assert.match(text, /surfaced 1 times, opened 0 times/);
    assert.match(text, /Would re-learning it cost a real investigation/);
    assert.match(text, /never been opened/);
    assert.ok(text.includes(PROPOSALS_HEADING));
  });
});

describe("writeIndex", () => {
  test("groups by what each gotcha covers and carries its usage", () => {
    const root = project();
    const store = new GotchaStore(root);
    const scoped = store.add(BILLING);
    const wide = store.add({ ...BILLING, summary: "Deploys need two migration passes", paths: [], aliases: ["deploy"] });
    const ledger = new Ledger(store);
    ledger.recordSurfaced([scoped.id]);
    ledger.recordRead(scoped.id);

    const written = writeIndex(store, ledger);
    const text = readFileSync(written.path, "utf8");
    assert.equal(written.count, 2);
    assert.match(text, /## src\/billing\//);
    assert.match(text, /## project-wide/);
    assert.match(text, new RegExp(`\\*\\*${scoped.id}\\*\\*`));
    assert.match(text, new RegExp(`\\*\\*${wide.id}\\*\\*`));
    assert.match(text, /surfaced 1, opened 1/);
  });

  test("an empty store still writes a valid index", () => {
    const store = new GotchaStore(project());
    assert.equal(writeIndex(store).count, 0);
  });
});

describe("parseProposals", () => {
  const cases: Array<[string, number, string]> = [
    ["retire foo — no longer true", 1, "plain retire"],
    ["- retire foo — no longer true", 1, "bulleted"],
    ["- [ ] retire foo — no longer true", 1, "checkbox"],
    ["merge keep <- drop — same fact", 1, "merge"],
    ["something else entirely", 0, "ignored line"],
    ["retire foo", 1, "retire without reason"],
  ];
  for (const [input, expected, name] of cases) {
    test(name, () => assert.equal(parseProposals(`${PROPOSALS_HEADING}\n${input}`).length, expected));
  }

  test("only reads below the proposals heading", () => {
    const parsed = parseProposals(`retire above — ignored\n${PROPOSALS_HEADING}\nretire below — counted`);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].kind === "retire" ? parsed[0].id : "", "below");
  });
});

describe("applyProposals", () => {
  test("retires, logs the reason and clears counters", () => {
    const root = project();
    const store = new GotchaStore(root);
    const a = store.add(BILLING);
    const ledger = new Ledger(store);
    ledger.recordSurfaced([a.id]);
    const applied = applyProposals(store, [{ kind: "retire", id: a.id, reason: "stale" }], ledger);
    assert.deepEqual(applied, [`retired ${a.id}`]);
    assert.equal(store.list().length, 0);
    assert.equal(ledger.usage(a.id).surfaced, 0);
    assert.match(readFileSync(join(store.cacheDir, "retired.log"), "utf8"), /stale/);
  });

  test("merge keeps one, folds in the other, and deletes the drop", () => {
    const root = project();
    const store = new GotchaStore(root);
    const keep = store.add(BILLING);
    const drop = store.add({ ...BILLING, summary: "Second note about cents", paths: ["src/export/"], aliases: ["csv"] });
    applyProposals(store, [{ kind: "merge", keep: keep.id, drop: drop.id, reason: "same fact" }]);
    const merged = store.get(keep.id);
    assert.equal(store.get(drop.id), undefined);
    assert.deepEqual(merged?.paths, ["src/billing/", "src/export/"]);
    assert.match(merged?.body ?? "", /Merged from/);
  });

  test("missing ids are skipped, not fatal", () => {
    const store = new GotchaStore(project());
    assert.match(applyProposals(store, [{ kind: "retire", id: "ghost", reason: "x" }])[0], /skipped ghost/);
  });
});

describe("apply round trip", () => {
  test("a packet with appended proposals applies cleanly", () => {
    const root = project();
    const store = new GotchaStore(root);
    const a = store.add(BILLING);
    const b = store.add({ ...BILLING, summary: "Unrelated timezone note about reports", paths: [], aliases: ["tz"] });
    const packet = auditPacket(store, root);
    writeFileSync(packet.path, `${readFileSync(packet.path, "utf8")}\nretire ${b.id} — the code was deleted\n`);
    const applied = applyProposals(store, parseProposals(readFileSync(packet.path, "utf8")));
    assert.deepEqual(applied, [`retired ${b.id}`]);
    assert.deepEqual(store.list().map((g) => g.id), [a.id]);
  });
});
