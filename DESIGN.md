# pi-gotcha design

What is built and why it is shaped this way. [README.md](README.md) is the overview; this is the detail.

## Storage

```
<project>/.gotchas/
  invoice-cents.md
  staging-migration-twice.md
  .gitignore          # written on first use, ignores .cache/
  .cache/             # embeddings; rebuildable, never synced
```

One markdown file per gotcha, YAML header plus body:

| Field | Required | Meaning |
| --- | --- | --- |
| `summary` | yes | The one line that gets surfaced, max 200 characters |
| `paths` | no | Files and directory prefixes covered. Empty means project-wide |
| `aliases` | no | Other words for the same thing; what retrieval leans on |
| `evidence` | yes | Expected versus actual, and how it was found |
| `created` / `updated` | auto | Dates |

One file per gotcha so concurrent additions on different devices merge without conflict. Ids are a slug of the summary, deduplicated with a numeric suffix. Malformed files are skipped rather than fatal, so a hand-edit gone wrong costs one gotcha, not the store.

`signature()` keys on mtime and size, not the `updated` date, which has day granularity and would otherwise serve a stale index for the rest of a session that edited a gotcha.

## Retrieval

Three channels with deliberately different scopes.

**1. By path.** Every tool call's input is scanned for path-shaped strings that exist, or whose parent directory exists, so a file about to be created still matches. A gotcha matches when one of its `paths` equals the touched path or is a directory prefix of it. No ranking: a path matches or it doesn't.

**2. By relevance.** Project-wide gotchas can't be reached by touch, so they're ranked against the user's prompt at `before_agent_start`, then gated (below). Model prose and tool output are excluded from the query: they're long and drift toward what the agent just said rather than what it was asked.

**3. By explicit search.** The tool's `search` action ranks everything and applies the relevance floor.

Ranking is hybrid: MiniSearch (BM25, fuzzy, prefix) over summary, aliases, paths and body with summary and aliases boosted, plus cosine similarity over embeddings of `summary + aliases`. The two are combined by reciprocal rank fusion, `1/(60 + rank)`, because their scores are not on a common scale.

### Two thresholds, because the scores mean different things

A BM25 score is a fraction of the query's own term mass, so it shrinks as the query grows and can't be compared against a constant; what is stable is how far the top result stands out from the best result that wouldn't have been shown anyway (`standout`, default 1.4). Cosine over normalized vectors is bounded and comparable across queries, so an absolute floor is meaningful (`semanticFloor`, default 0.55) and catches what the ratio misses: several genuinely relevant results that therefore don't stand out from each other.

`prune()`, used by search, keeps what either channel is confident about (cosine ≥ 0.45, or BM25 ≥ 35% of the top hit) and uses cosine only to veto the plainly unrelated (`searchVeto`, default 0.15). That shape came from `npm run floors`: filtering on cosine alone reaches full silence at 0.25 and costs 8 of 40 recall, while this rule holds 30 of 40 with every unanswerable query silenced.

## Embeddings

Optional and lazily imported, never a declared dependency: transformers.js pulls onnxruntime and sharp, about 300 MB, which has no business on a device that doesn't want it.

- **local** — `all-MiniLM-L6-v2`, quantized, on the CPU.
- **remote** — any OpenAI-compatible `/v1/embeddings` endpoint.
- **off** — keyword only.
- **auto** (default) — local if the package is installed, else remote if an endpoint is configured, else off.

Install needs `--ignore-scripts`, because sharp builds from source on current Node; nothing here uses images, and onnxruntime still loads. Vectors are cached by content hash under `.gotchas/.cache/`, keyed by embedder id so switching models invalidates rather than mixes incomparable vectors. Refresh is backgrounded at session start; until it finishes, ranking is keyword-only rather than blocked. Any failure degrades to keyword-only and is reported by `/gotchas`.

## Surfacing

```
tool_call          → extract paths → match → stage
before_agent_start → rank project-wide → gate → stage
agent_settled      → flush all staged as ONE appended message
session_compact    → clear the "already delivered" set
```

One message per turn, not one per match: Pi drains one steering message per model round trip. Delivery is an appended message, never a system-prompt edit, so the cached prompt prefix survives. Each gotcha surfaces at most once per session; reading one through the tool withdraws its staged line, since pull beats push. Compaction clears the seen set because those lines are gone from context.

## The tool

`gotcha` with six actions: `search`, `read`, `list`, `add`, `update`, `retire`.

Write guards, all deterministic, because the write desk is where memory systems fail:

| Guard | Effect |
| --- | --- |
| Evidence required, 15+ characters | A trivial observation has nothing to put there |
| Summary ≤ 200 characters | Keeps the surfaced line one line |
| Duplicate check | Token overlap ≥ 0.5, or cosine ≥ `duplicateThreshold`, returns the existing gotcha instead of filing a near-copy |
| Session cap | `sessionWriteCap` (3) new gotchas per session, then update-only |
| Reason required to retire | Deletion is deliberate; git keeps the file |

## Audit

Deterministic checks first, model judgement second, human approval last:

1. `/gotchas-review` prints stale paths, near-duplicate pairs and thin evidence. No model involved.
2. `/gotchas-audit` writes an audit packet (every gotcha, compact, plus the automatic findings and the judging rules) to `.gotchas/.cache/`, then asks the agent to delegate the review to a subagent that appends proposals to the file. The subagent never touches the store.
3. The human edits the file, deleting proposals they disagree with.
4. `/gotchas-apply <file>` parses what survived and executes it, after a confirmation prompt. Two verbs: `retire <id>` and `merge <keep> <- <drop>`.

## Configuration

`~/.config/pi-gotcha/settings.json`, or `PI_GOTCHA_EMBEDDINGS` for the provider alone:

```json
{
  "surface": true,
  "maxSurfacedPerTurn": 2,
  "standout": 1.4,
  "semanticFloor": 0.55,
  "searchVeto": 0.15,
  "sessionWriteCap": 3,
  "duplicateThreshold": 0.55,
  "embeddings": { "provider": "auto", "model": "Xenova/all-MiniLM-L6-v2" }
}
```

## Testing

- `npm test` — 94 tests: store round-trips and malformed input, path matching including its known blind spots, fusion and both thresholds, every write guard, surfacing lifecycle, audit parsing and application.
- `npm run bench` — recall by query kind over the fixture corpus, with the misses printed by name. Add `PI_GOTCHA_EMBEDDINGS=local` to compare modes.
- `npm run floors` — the recall-against-silence curve behind the default floor.

The fixture corpus (`test/fixtures/corpus.ts`) is 30 gotchas and 45 queries, including paraphrases sharing no vocabulary with the stored wording, typos, task-phrased queries, and 5 unanswerable ones that must return nothing.

## Known limits

- **Path extraction is best-effort.** A path built from a shell variable is missed, and so is a new file at the project root, which has no parent segment to prove it. Both are covered by tests that assert the limit rather than paper over it.
- **Paraphrase recall is 42%** of delivered results in both modes. Aliases are the mitigation, and they depend on the model writing good ones.
- **Typos cost recall**: fuzzy matching handles one-word slips, not `"stipe webhok retrys"`.
- **The floor is tuned on a synthetic corpus** of 30 gotchas. Re-run `npm run floors` against a real store before trusting the default.
- **Model discipline is unproven.** The guards bound the damage; `/gotchas-review` and code review catch the rest.
