import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { fuse, gate, prune, type Ranked } from "../extensions/lib/rank.ts";

describe("fuse", () => {
  test("an entry ranked well by both channels beats one ranked well by either alone", () => {
    const lexical = [
      { id: "both", score: 5 },
      { id: "lex-only", score: 4.9 },
    ];
    const semantic = [
      { id: "sem-only", score: 0.9 },
      { id: "both", score: 0.8 },
    ];
    const fused = fuse([lexical, semantic]);
    assert.equal(fused[0].id, "both");
  });

  test("keeps each channel's own score for gating", () => {
    const fused = fuse([[{ id: "a", score: 7 }], [{ id: "a", score: 0.7 }]]);
    assert.equal(fused[0].lexical, 7);
    assert.equal(fused[0].semantic, 0.7);
  });

  test("an entry found by only one channel still ranks", () => {
    const fused = fuse([[{ id: "a", score: 1 }], []]);
    assert.deepEqual(fused.map((entry) => entry.id), ["a"]);
    assert.equal(fused[0].semantic, undefined);
  });

  test("respects the limit", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ id: `g${i}`, score: 30 - i }));
    assert.equal(fuse([many, []], 5).length, 5);
  });
});

describe("prune", () => {
  const VETO = 0.15;

  test("empty stays empty", () => {
    assert.deepEqual(prune([], VETO), []);
  });

  test("keeps a confident meaning match even when keywords are weak", () => {
    const kept = prune([{ id: "a", score: 1, lexical: 0.1, semantic: 0.6 }], VETO);
    assert.deepEqual(kept.map((entry) => entry.id), ["a"]);
  });

  test("keeps a strong keyword match whose meaning score is middling", () => {
    const kept = prune(
      [
        { id: "a", score: 1, lexical: 10, semantic: 0.3 },
        { id: "b", score: 0.9, lexical: 1, semantic: 0.3 },
      ],
      VETO,
    );
    assert.deepEqual(kept.map((entry) => entry.id), ["a"]);
  });

  test("vetoes everything plainly unrelated, leaving nothing", () => {
    const kept = prune(
      [
        { id: "a", score: 1, lexical: 10, semantic: 0.05 },
        { id: "b", score: 0.9, lexical: 9, semantic: 0.02 },
      ],
      VETO,
    );
    assert.deepEqual(kept, []);
  });

  test("without embeddings it falls back to relative keyword strength", () => {
    const kept = prune(
      [
        { id: "a", score: 1, lexical: 10 },
        { id: "b", score: 0.9, lexical: 1 },
      ],
      VETO,
    );
    assert.deepEqual(kept.map((entry) => entry.id), ["a"]);
  });

  test("without embeddings and no keyword signal, nothing survives", () => {
    assert.deepEqual(prune([{ id: "a", score: 1, lexical: 0 }], VETO), []);
  });
});

const OPTIONS = { standout: 1.4, semanticFloor: 0.55, cap: 2 };

function ranked(entries: Array<Partial<Ranked> & { id: string }>): Ranked[] {
  return entries.map((entry) => ({ score: 0, ...entry }));
}

describe("gate", () => {
  test("empty input surfaces nothing", () => {
    assert.deepEqual(gate([], OPTIONS), { surfaced: [], reason: "empty" });
  });

  test("a clear keyword winner passes", () => {
    const result = gate(
      ranked([
        { id: "a", lexical: 10 },
        { id: "b", lexical: 3 },
        { id: "c", lexical: 2 },
      ]),
      OPTIONS,
    );
    assert.equal(result.reason, "lexical-standout");
    assert.deepEqual(result.surfaced.map((entry) => entry.id), ["a", "b"]);
  });

  test("a flat keyword ranking is refused", () => {
    const result = gate(
      ranked([
        { id: "a", lexical: 3.0 },
        { id: "b", lexical: 2.9 },
        { id: "c", lexical: 2.8 },
      ]),
      OPTIONS,
    );
    assert.equal(result.reason, "below-threshold");
    assert.deepEqual(result.surfaced, []);
  });

  test("fewer results than the cap means no rival, so a real hit passes", () => {
    const result = gate(ranked([{ id: "a", lexical: 2 }]), OPTIONS);
    assert.equal(result.reason, "lexical-standout");
  });

  test("strong meaning-match passes even when keywords are flat", () => {
    const result = gate(
      ranked([
        { id: "a", lexical: 3.0, semantic: 0.71 },
        { id: "b", lexical: 2.9, semantic: 0.2 },
        { id: "c", lexical: 2.8, semantic: 0.1 },
      ]),
      OPTIONS,
    );
    assert.equal(result.reason, "semantic-floor");
    assert.deepEqual(result.surfaced.map((entry) => entry.id), ["a"]);
  });

  test("weak meaning-match is refused", () => {
    const result = gate(
      ranked([
        { id: "a", lexical: 3.0, semantic: 0.4 },
        { id: "b", lexical: 2.9, semantic: 0.39 },
        { id: "c", lexical: 2.8, semantic: 0.2 },
      ]),
      OPTIONS,
    );
    assert.equal(result.reason, "below-threshold");
  });

  test("never surfaces more than the cap", () => {
    const result = gate(
      ranked([
        { id: "a", lexical: 10 },
        { id: "b", lexical: 9 },
        { id: "c", lexical: 1 },
        { id: "d", lexical: 0.5 },
      ]),
      OPTIONS,
    );
    assert.equal(result.surfaced.length, 2);
  });

  test("standout of 1 disables the cutoff", () => {
    const result = gate(
      ranked([
        { id: "a", lexical: 3.0 },
        { id: "b", lexical: 2.9 },
        { id: "c", lexical: 2.9 },
      ]),
      { ...OPTIONS, standout: 1 },
    );
    assert.equal(result.reason, "lexical-standout");
  });
});
