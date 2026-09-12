# pi-gotcha design

What is built and why it is shaped this way. [README.md](README.md) is the overview; this is the detail.

## Storage

```
<project>/.gotchas/
  invoice-cents.md
  settings.json       # optional, per-project overrides
  .gitignore          # written on first use, ignores .cache/
  .cache/             # embeddings, write budget, usage counts, audit packets
```

One markdown file per gotcha, YAML header plus body:

| Field | Required | Meaning |
| --- | --- | --- |
| `summary` | yes | The one line that gets surfaced, max 200 characters |
| `paths` | no | Files and directory prefixes covered. Empty, or the repo root, means project-wide |
| `aliases` | no | Other words for the same thing; retrieval leans on these |
| `expected` | yes | What the author thought would happen |
| `actual` | yes | What happened instead, and how they found out |
| `created` / `updated` | auto | Dates |

One file per gotcha so concurrent additions on different devices merge without conflict. Malformed files are skipped rather than fatal. `list()` is cached behind `signature()`, which stats rather than parses, because it runs on every tool call.

## Retrieval

**1. By path.** A tool call's input is scanned for path-shaped strings that exist, or whose parent exists. A gotcha matches when one of its `paths` equals or is a directory prefix of a touched path. Matches are ordered by scope depth and capped at `maxPathSurfacedPerTurn` (3), so a note about this file beats one about its package and a store full of broad notes cannot flood a turn.

Only addressing is scanned, never payload. An edit or write carries the whole file body, and a path in an import or comment is not a claim of attention; long strings are scanned only under a key that names a location (`path`, `command`, `file`…) and only at the head, where a command puts its arguments.

**2. By relevance.** Gotchas with no path — or scoped at the repo root — can't be reached by touch, so they're ranked against the user's prompt at `before_agent_start` and gated. Repo-wide knowledge is legitimate; surfacing it on every file touch is not, so it goes through ranking instead. Model prose and tool output are excluded from the query.

**3. By explicit search.** The tool's `search` ranks everything and applies the relevance floor.

Ranking is hybrid: MiniSearch (BM25, fuzzy, prefix) over summary, aliases, paths and body, plus cosine over embeddings of `summary + aliases`, combined by reciprocal rank fusion (`1/(60 + rank)`) because the two scores are not on a common scale.

### Two thresholds, because the scores mean different things

BM25 is a fraction of the query's own term mass, so it shrinks as the query grows and can't be compared against a constant; what is stable is how far the top result stands out from the best result that wouldn't have been shown anyway (`standout`, 1.4). Cosine over normalized vectors is bounded and comparable, so an absolute floor is meaningful (`semanticFloor`, 0.55).

`prune()`, used by search, keeps what either channel is confident about (cosine ≥ 0.45, or BM25 ≥ 35% of the top hit) and uses cosine only to veto the plainly unrelated (`searchVeto`, 0.15). From `npm run floors`: cosine alone reaches full silence at 0.25 and costs 8 of 40 recall; this rule holds 30 of 40 with every unanswerable query silenced.

A ratio can't discriminate on a store too small to have rivals, so an unsolicited gotcha must also share a non-stopword with the prompt whenever embeddings are unavailable.

## Embeddings

Optional, lazily imported, never a declared dependency: transformers.js pulls onnxruntime and sharp, about 300 MB.

- **local** — `all-MiniLM-L6-v2`, quantized, on the CPU.
- **remote** — any OpenAI-compatible `/v1/embeddings` endpoint.
- **off** — keyword only.
- **auto** (default) — local if installed, else remote if configured, else off.

Install needs `--ignore-scripts`; sharp builds from source on current Node and nothing here uses images. The model loads on the first query that could use it, not at session start, because every background subagent runs in its own process and would otherwise each pay ~100 MB and a few seconds for a feature the session may never touch. That first query runs keyword-only.

Vectors are cached by content hash, keyed by embedder id so switching models invalidates rather than mixes. Any failure degrades to keyword-only and is reported by `/gotchas`.

## Surfacing

```
tool_call          → extract paths → match, deepest first, capped → stage
before_agent_start → rank project-wide → gate → stage
agent_settled      → flush all staged as ONE appended message → record usage
session_compact    → clear the "already delivered" set
```

One message per turn, because Pi drains one steering message per model round trip. Delivery is an appended message, never a system-prompt edit, so the cached prefix survives. Each gotcha surfaces at most once per session; reading one withdraws its staged line. A line names one scope plus a count (`src/billing/ +2`), never the whole list.

## The tool

`gotcha` with six actions: `search`, `read`, `list`, `add`, `update`, `retire`.

The write desk is where memory systems fail, so every guard here is deterministic:

| Guard | Effect |
| --- | --- |
| `expected` and `actual` both required | Structure is the bar. "I set this to 2 because the user likes even numbers" has nothing to put in either |
| Junk patterns refused | Stated preferences, "I changed X", TODOs and reminders are rejected by wording, on add and update |
| At least 2 aliases | Retrieval leans on them; without them the gotcha will not be found again |
| Summary ≤ 200 characters | Keeps the surfaced line one line |
| Duplicate check | Token overlap ≥ `duplicateOverlap`, or cosine ≥ `duplicateThreshold`, returns the existing gotcha |
| Daily write budget | `dailyWriteCap` (5) across every session and subagent, counted in the store, not in memory. `update` is exempt: refining an existing gotcha is unlimited. Over budget, the tool asks the user through `ctx.ui.confirm` and counts approvals; with no UI — a background subagent — it is refused. `/gotchas-budget <n>` raises the allowance for today only |
| Reason required to retire | Logged to `.cache/retired.log`; git keeps the file |
| `list` capped | `listLimit` (30), with a count of what it left out |

## Audit

Deterministic checks first, model judgement second, human approval last:

1. `/gotchas-review` prints what surfaced repeatedly and was never opened, stale paths, near-duplicates and thin evidence. No model involved.
2. `/gotchas-audit` writes a packet — every gotcha with its usage counts, the automatic findings, and the judging rules — then asks the agent to delegate the review to a subagent that appends proposals. The subagent never touches the store.
3. The human edits the file, deleting proposals they disagree with.
4. `/gotchas-apply` (defaulting to the newest packet) parses what survived and executes it behind a confirmation. Two verbs: `retire <id>` and `merge <keep> <- <drop>`.

Usage counts are what make this evidence-based: surfaced many times and never opened is the signature of noise, and both the report and the packet rules say so.

## Configuration

`~/.config/pi-gotcha/settings.json`, overridden per project by `<project>/.gotchas/settings.json`, with `PI_GOTCHA_EMBEDDINGS` overriding the provider everywhere:

```json
{
  "surface": true,
  "overBudgetPrompt": true,
  "maxSurfacedPerTurn": 2,
  "maxPathSurfacedPerTurn": 3,
  "standout": 1.4,
  "semanticFloor": 0.55,
  "searchVeto": 0.15,
  "dailyWriteCap": 5,
  "duplicateThreshold": 0.55,
  "duplicateOverlap": 0.35,
  "minEvidence": 15,
  "requireAliases": 2,
  "listLimit": 30,
  "embeddings": { "provider": "auto", "model": "Xenova/all-MiniLM-L6-v2" }
}
```

`"surface": false` in a project turns off both automatic channels there while leaving the tool available.

## Testing

- `npm test` — 160 tests: store round-trips and malformed input, path matching including its known blind spots, fusion and all three thresholds, every write guard and refusal, the ledger's budget and usage counters, settings precedence, surfacing lifecycle, audit parsing and application, and extension wiring driven through a fake `pi`.
- `npm run bench` — recall by query kind over the fixture corpus, misses printed by name. `PI_GOTCHA_EMBEDDINGS=local` to compare modes.
- `npm run floors` — the recall-against-silence curve behind the default floor.

## Known limits

- **Path extraction is best-effort.** A path built from a shell variable is missed, as is a new file at the project root. Both are asserted as tests rather than papered over.
- **Paraphrase recall is 42%** of delivered results in both modes; aliases are the mitigation.
- **Typos cost recall**: fuzzy matching handles one-word slips, not `"stipe webhok retrys"`.
- **The floor is tuned on a synthetic corpus** of 30 gotchas; re-run `npm run floors` against a real store.
- **Junk detection is wording-based.** A preference dressed up as a finding will pass; the daily budget, usage counts and review command are the backstop.
- **The first query of a session is keyword-only** while the model loads.
