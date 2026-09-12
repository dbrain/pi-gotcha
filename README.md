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
trigger: chasing rows missing from a finance export
created: 2026-09-12
---

`Invoice.total` is an integer count of cents everywhere below the API boundary...
```

- `summary` is the single line that gets surfaced. Everything else is read on demand.
- `paths` is what the gotcha covers: files, directory prefixes, or empty for project-wide. Repo-wide knowledge is fine — scoping something at the repo root moves it to the relevance channel rather than surfacing it on every file you touch.
- `aliases` are the other words someone might search for, written once at record time.
- `expected` and `actual` are the bar for recording anything at all. A preference or a note about what you just did has nothing to put in them.
- `trigger` is the work you'll be doing when you next need this, phrased as a task. It's a concrete question a model can answer well, and it's written in the language searches actually use — which is why it carries most of the paraphrase recall.

Everything except `paths` feeds retrieval: `summary` and `aliases` and `trigger` weighted highest, then the evidence pair, then the body.

One file per gotcha, so two devices adding gotchas produce no merge conflict.

## How knowledge comes back

Two channels, neither of which needs the agent to remember to ask:

1. **By path.** A tool call touches `src/billing/invoice.ts`, and any gotcha covering that file or a parent directory surfaces its summary at the end of the turn. Deterministic: a path lookup, no ranking.
2. **By relevance.** Gotchas with no path (project-wide) are ranked against what the agent is actually doing, and only clear winners surface. This is what keeps "ideally only if relevant" honest.

Both are capped — 3 lines from paths, 2 from relevance, the most specific scope first — each gotcha at most once per session, appended as a message so the cached prompt prefix stays intact. Only a tool call's addressing is scanned, never the file contents it carries, so a path mentioned inside a diff is not treated as a visit.

The agent can also search explicitly. `read` is the only channel that returns a body, and it returns it 2000 characters at a time, so one long gotcha can't flood a session. Bodies are capped at 8000 characters on the way in: record the constraint and the values that matter, and point at the file or commit instead of pasting output.

`/gotchas-index` writes a browsable map of the whole store, grouped by what each gotcha covers, for when you want to read it yourself.

See [DESIGN.md](DESIGN.md) for how ranking, storage and surfacing actually work, and the build order.

## Measured

`npm run bench` scores retrieval against 30 synthetic gotchas and 45 queries written to attack it (`test/fixtures/corpus.ts`). Results delivered at rank 3, after the relevance floor:

| Query kind | Keyword only | With embeddings |
| --- | --- | --- |
| Wording overlaps the stored summary | 8/8 | 8/8 |
| Mentions a file or directory | 5/5 | 4/5 |
| Phrased as the task being worked on | 9/10 | 8/10 |
| Typos and misspellings | 4/5 | 4/5 |
| **Paraphrased, no shared vocabulary** | 5/12 | **9/12** |
| **Unanswerable (should return nothing)** | 0/5 silent | **5/5 silent** |

**Asking for a `trigger` is what fixed paraphrase.** Delivered paraphrase recall was 42% in both modes while only the summary and aliases were indexed. Recording the work someone will be doing when they need the gotcha — and indexing it along with the expected/actual pair — took it to 75%, and raw recall from 31/40 to 36/40. The gain arrives through the embeddings, not the keyword index: the trigger is written in the language searches actually use.

**Embeddings still buy silence.** Keyword ranking always returns its best three guesses however bad they are, so every unanswerable query gets confident-looking junk; only cosine can say "nothing here is about this". Keyword-only remains a real option — it wins one file query and one task query — but it is paraphrase-blind.

The floor costs one task query and one path query, which is the price of that silence. `npm run floors` prints the curve, and the operating point moved once `trigger` joined the embedded text, so re-run it after changing what is indexed.

`npm run floors` prints the recall-against-silence curve that set the default floor.

## Can a weak model actually use it?

`npm run eval` puts a live model in front of the real tool — ten scenarios, five worth recording and five not — and scores both its judgement and what the guards did with each attempt.

Against **Gemma 4 12B** (chosen as a deliberately weak model), temperature 0:

| | |
| --- | --- |
| Decisions matching intent | 10/10 |
| Worth recording, stored | 5/5 |
| Junk attempted | 0/5 |
| Aliases written | 4 on every record |

It skipped the preference, the task log, the plan, the thing the code already said, and the thing that worked as documented — without any guard needing to fire.

`npm run eval:session` is the harder version: sixteen episodes from actually building this package, unlabelled and in the order they happened — ten things that cost real investigation (Node's type stripping rejecting constructor parameter properties, a dependency that builds from source and dies, a template renderer parsing JSON before substituting, an install script clobbering environment overrides) mixed with six pieces of ordinary work (ran the tests, wrote a README section, pushed a commit).

Same model: **16/16 decisions correct, 10/10 worth recording stored, zero false positives.** The triggers it wrote were genuinely useful — "debugging why a subagent cannot access a tool that is available to the parent agent" — though one misread its episode, and its summaries run a little generic next to a human's.

Two caveats. A human wrote those episode summaries from the session, so it is real material filtered through one person's compression; a raw transcript would be harder. And both evals are single-turn, where a real session asks the same judgement 40k tokens deep.

The run earned its keep in another way: the first pass had one genuine gotcha **rejected by my own junk filter**, because the model wrote "(like formatted currency)" and the preference pattern matched the word "like". The patterns now require a person doing the preferring, and that summary is a regression test.

## Open question: can agents be trusted to write these?

Partly, and the design leans on that rather than assuming it.

The honest evidence comes from pi-canon's benchmarks: of 14 recall failures, 13 were write-side, meaning the knowledge was never captured or was later overwritten. Retrieval was almost never the problem. So the write desk is where this succeeds or fails.

What a model gets wrong is not malice but calibration: asked to record what's important, it records what it just did. The countermeasures here are deterministic, not prompt-based:

- **Required `expected` and `actual` fields.** Recording trivia becomes awkward, because there is nothing to put in them. The description names the full set an `add` needs, because a model that fills `expected` and forgets `actual` loses the gotcha to this guard: naming them took stored gotchas from 1/3 to 3/3 under a realistic session prompt, junk still refused.
- **Wording-based refusal.** Stated preferences, "I changed X to Y", TODOs and reminders are rejected outright.
- **A vagueness floor.** "Cache behaves oddly" is refused: too vague to ever find again.
- **Worked examples in the tool description.** A small model copies a shown pattern far more reliably than it follows a stated rule.
- **Review before it lands.** By default a write past the daily budget asks you: record it anyway, replace an existing gotcha (today's writes first, then the closest matches), or skip. A replacement spends no budget, because the store didn't grow.
- **Subagents propose rather than write.** A background agent has no one to ask, so its write lands in `.gotchas/proposed/` — tracked by git, invisible to search until accepted, resolved with `/gotchas-proposals`.
- **A duplicate check on write** returns the existing gotcha instead of filing a near-copy.
- **A budget of 5 new gotchas per day**, counted in the store, so it holds across sessions and across the separate processes background subagents run in. Updating an existing gotcha is unlimited and never spends budget. When the budget runs out the tool asks you to approve the next one, and approvals are counted so a hot day is visible later; a background subagent has nobody to ask and is simply refused. For a day of deep work, `/gotchas-budget 20` raises it in one go.
- **At least two aliases**, because a gotcha nobody can find again is only cost.
- **Usage counts.** Every surfaced line and every read is recorded, so `/gotchas-review` can show what surfaces constantly and is never opened — the signature of noise — and the audit packet makes the model judge against that rather than vibes.
- **`/gotchas-review` and `/gotchas-apply`** let a human clear out junk in seconds, and `.gotchas/` shows up in code review like any other file.

So: not a manual task, but not unsupervised either. The agent drafts, deterministic rules block the obvious failure modes, and you skim the diff. If after a month the notes are mostly noise, the fallback is the current arrangement, a hand-written `## Gotchas` section in `AGENTS.md`, and nothing is lost but the extension.
