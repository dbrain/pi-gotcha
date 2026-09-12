# pi-gotcha

A Pi extension for hard-won project knowledge: the things that cost real investigation and that reading the code won't tell you.

## Install

```sh
pi install npm:pi-gotcha          # or: pi install /path/to/pi-gotcha
```

Meaning-based search is optional and needs one more package inside Pi's module tree:

```sh
npm install --prefix ~/.pi/agent/npm --ignore-scripts @huggingface/transformers
```

`--ignore-scripts` is required: transformers.js depends on `sharp` for image inputs, which this project never uses, and sharp tries to build from source on newer Node versions. Skipping install scripts avoids that build; onnxruntime and the embedding pipeline still load. Without this package, retrieval falls back to keyword-only search and says so.

## The problem

Some knowledge isn't in the code and can't be re-derived cheaply:

- "Invoice totals are integer cents. The finance parser drops any line containing a comma, silently."
- "The staging deploy needs the migration run twice; the first pass creates the enum the second one uses."
- "`retryOnConflict` looks generic but only works for the Postgres path. The SQLite path swallows the error."

Re-learning one of these costs an agent a long debugging session. Writing it down costs one sentence.

Everything else belongs elsewhere: how the code works is in the code, and why one line is unusual is a comment at that line. pi-gotcha is only for knowledge that has no home.

## Goals

1. **Near-zero LLM effort to retrieve.** Relevant gotchas arrive unasked, as one line each, when the agent works in the area they cover.
2. **Near-zero noise.** A gotcha that isn't relevant to the current work never appears. Project-wide gotchas are ranked against the work, not dumped every session.
3. **Cheap to store.** One tool call. No summarizing pass, no background model.
4. **Searchable by meaning, not spelling.** An agent that asks about "login" should find the note about "session tokens".
5. **Cross-device by default.** Notes live in the repo and travel through git.
6. **Reviewable.** A human can read, edit and delete everything with an editor, and see additions in a diff.

## Non-goals

- Not a wiki, and not a summary of the codebase. If the code says it, don't store it.
- No event log or session history. That's pi-vcc's job.
- No automatic capture. Every gotcha is written by an explicit tool call.
- No background LLM work of any kind.

## Shape

One gotcha is one markdown file in `<project>/.gotchas/`:

```markdown
---
summary: Invoice totals are integer cents; the finance CSV parser drops any line with a comma
paths: [src/billing/, src/export/csv.ts]
aliases: [money formatting, currency, amounts, thousands separator]
expected: The export to contain the formatted total like every other column
actual: The row vanished with no error; the parser treats a comma as corruption
created: 2026-09-12
---

`Invoice.total` is an integer count of cents everywhere below the API boundary...
```

- `summary` is the single line that gets surfaced. Everything else is read on demand.
- `paths` is what the gotcha covers: files, directory prefixes, or empty for project-wide. Repo-wide knowledge is fine — scoping something at the repo root moves it to the relevance channel rather than surfacing it on every file you touch.
- `aliases` are the other words someone might search for, written once at record time.
- `expected` and `actual` are the bar for recording anything at all. A preference or a note about what you just did has nothing to put in them.

One file per gotcha, so two devices adding gotchas produce no merge conflict.

## How knowledge comes back

Two channels, neither of which needs the agent to remember to ask:

1. **By path.** A tool call touches `src/billing/invoice.ts`, and any gotcha covering that file or a parent directory surfaces its summary at the end of the turn. Deterministic: a path lookup, no ranking.
2. **By relevance.** Gotchas with no path (project-wide) are ranked against what the agent is actually doing, and only clear winners surface. This is what keeps "ideally only if relevant" honest.

Both are capped — 3 lines from paths, 2 from relevance, the most specific scope first — each gotcha at most once per session, appended as a message so the cached prompt prefix stays intact. Only a tool call's addressing is scanned, never the file contents it carries, so a path mentioned inside a diff is not treated as a visit.

The agent can also search explicitly, which is the only channel that returns full text.

See [DESIGN.md](DESIGN.md) for how ranking, storage and surfacing actually work, and the build order.

## Measured

`npm run bench` scores retrieval against 30 synthetic gotchas and 45 queries written to attack it (`test/fixtures/corpus.ts`). Results delivered at rank 3, after the relevance floor:

| Query kind | Keyword only | With embeddings |
| --- | --- | --- |
| Wording overlaps the stored summary | 8/8 | 8/8 |
| Mentions a file or directory | 5/5 | 5/5 |
| Phrased as the task being worked on | 10/10 | 9/10 |
| Typos and misspellings | 3/5 | 3/5 |
| Paraphrased, no shared vocabulary | 5/12 | 5/12 |
| **Unanswerable (should return nothing)** | **0/5 silent** | **5/5 silent** |

**What embeddings actually buy is silence, not recall.** Raw paraphrase recall does improve, 42% to 58%, but the relevance floor trims it back to 42%, and one task query is lost. What changes decisively is the last row: keyword ranking always returns its best three guesses however bad they are, so every unanswerable query gets confident-looking junk. Only cosine similarity can say "nothing here is about this". If you don't care about that, keyword-only costs nothing and is 2 results behind over the whole corpus.

Paraphrase is the standing weakness either way: "why is the invoice total coming out one hundred times too big" still does not reach a gotcha whose summary says "integer cents". Aliases are the mitigation, which is why the tool asks for them on every write.

`npm run floors` prints the recall-against-silence curve that set the default floor.

## Open question: can agents be trusted to write these?

Partly, and the design leans on that rather than assuming it.

The honest evidence comes from pi-canon's benchmarks: of 14 recall failures, 13 were write-side, meaning the knowledge was never captured or was later overwritten. Retrieval was almost never the problem. So the write desk is where this succeeds or fails.

What a model gets wrong is not malice but calibration: asked to record what's important, it records what it just did. The countermeasures here are deterministic, not prompt-based:

- **Required `expected` and `actual` fields.** Recording trivia becomes awkward, because there is nothing to put in them.
- **Wording-based refusal.** Stated preferences, "I changed X to Y", TODOs and reminders are rejected outright.
- **A duplicate check on write** returns the existing gotcha instead of filing a near-copy.
- **A budget of 5 new gotchas per day**, counted in the store, so it holds across sessions and across the separate processes background subagents run in. Updating an existing gotcha is unlimited and never spends budget. When the budget runs out the tool asks you to approve the next one, and approvals are counted so a hot day is visible later; a background subagent has nobody to ask and is simply refused. For a day of deep work, `/gotchas-budget 20` raises it in one go.
- **At least two aliases**, because a gotcha nobody can find again is only cost.
- **Usage counts.** Every surfaced line and every read is recorded, so `/gotchas-review` can show what surfaces constantly and is never opened — the signature of noise — and the audit packet makes the model judge against that rather than vibes.
- **`/gotchas-review` and `/gotchas-apply`** let a human clear out junk in seconds, and `.gotchas/` shows up in code review like any other file.

So: not a manual task, but not unsupervised either. The agent drafts, deterministic rules block the obvious failure modes, and you skim the diff. If after a month the notes are mostly noise, the fallback is the current arrangement, a hand-written `## Gotchas` section in `AGENTS.md`, and nothing is lost but the extension.
