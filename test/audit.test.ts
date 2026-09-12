import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { applyProposals, audit, auditPacket, parseProposals, PROPOSALS_HEADING } from "../extensions/lib/audit.ts";
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
  evidence: "Expected 2,255.65 in the export and the row vanished with no error at all",
  paths: ["src/billing/"],
  aliases: ["money", "currency"],
  body: "Detail about cents.",
};

describe("audit", () => {
  test("flags paths that no longer exist", () => {
    const root = project();
    const store = new GotchaStore(root);
    store.add(BILLING);
    store.add({ ...BILLING, summary: "Deleted module still referenced", paths: ["src/gone/"] });
    const report = audit(store, root);
    assert.equal(report.stale.length, 1);
    assert.deepEqual(report.stale[0].scopes, ["src/gone/"]);
  });

  test("flags near-duplicate pairs", () => {
    const root = project();
    const store = new GotchaStore(root);
    store.add(BILLING);
    store.add({ ...BILLING, summary: "Invoice totals are integer cents and CSV export drops comma lines" });
    const report = audit(store, root);
    assert.equal(report.nearDuplicates.length, 1);
    assert.ok(report.nearDuplicates[0].overlap >= 0.35);
  });

  test("flags thin evidence", () => {
    const root = project();
    const store = new GotchaStore(root);
    store.add({ summary: "Something odd happens sometimes", evidence: "it broke once" });
    assert.equal(audit(store, root).thinEvidence.length, 1);
  });

  test("a clean store flags nothing", () => {
    const root = project();
    const store = new GotchaStore(root);
    store.add(BILLING);
    const report = audit(store, root);
    assert.deepEqual([report.stale.length, report.nearDuplicates.length, report.thinEvidence.length], [0, 0, 0]);
  });
});

describe("audit packet", () => {
  test("contains every gotcha and the proposals heading", () => {
    const root = project();
    const store = new GotchaStore(root);
    const a = store.add(BILLING);
    const packet = auditPacket(store, root);
    const text = readFileSync(packet.path, "utf8");
    assert.match(text, new RegExp(`### ${a.id}`));
    assert.ok(text.includes(PROPOSALS_HEADING));
    assert.match(text, /Would re-learning it cost a real investigation/);
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
    test(name, () => {
      assert.equal(parseProposals(`${PROPOSALS_HEADING}\n${input}`).length, expected);
    });
  }

  test("only reads below the proposals heading", () => {
    const text = `retire above — should be ignored\n${PROPOSALS_HEADING}\nretire below — counted`;
    const parsed = parseProposals(text);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].kind === "retire" ? parsed[0].id : "", "below");
  });
});

describe("applyProposals", () => {
  test("retires and reports", () => {
    const root = project();
    const store = new GotchaStore(root);
    const a = store.add(BILLING);
    const applied = applyProposals(store, [{ kind: "retire", id: a.id, reason: "stale" }]);
    assert.deepEqual(applied, [`retired ${a.id}`]);
    assert.equal(store.list().length, 0);
  });

  test("merge keeps one, folds in the other's paths and body, and deletes the drop", () => {
    const root = project();
    const store = new GotchaStore(root);
    const keep = store.add(BILLING);
    const drop = store.add({ ...BILLING, summary: "Second cents note", paths: ["src/export/"], aliases: ["csv"] });
    applyProposals(store, [{ kind: "merge", keep: keep.id, drop: drop.id, reason: "same fact" }]);
    const merged = store.get(keep.id);
    assert.equal(store.get(drop.id), undefined);
    assert.deepEqual(merged?.paths, ["src/billing/", "src/export/"]);
    assert.match(merged?.body ?? "", /Merged from/);
  });

  test("missing ids are skipped, not fatal", () => {
    const root = project();
    const store = new GotchaStore(root);
    const applied = applyProposals(store, [{ kind: "retire", id: "ghost", reason: "x" }]);
    assert.match(applied[0], /skipped ghost/);
  });
});

describe("apply round trip", () => {
  test("a packet with appended proposals applies cleanly", () => {
    const root = project();
    const store = new GotchaStore(root);
    const a = store.add(BILLING);
    const b = store.add({ ...BILLING, summary: "Unrelated timezone note", paths: [], aliases: ["tz"] });
    const packet = auditPacket(store, root);
    writeFileSync(packet.path, `${readFileSync(packet.path, "utf8")}\nretire ${b.id} — the code was deleted\n`);
    const applied = applyProposals(store, parseProposals(readFileSync(packet.path, "utf8")));
    assert.deepEqual(applied, [`retired ${b.id}`]);
    assert.deepEqual(store.list().map((g) => g.id), [a.id]);
  });
});
