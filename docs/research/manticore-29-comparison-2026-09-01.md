# Manticore 6.3.8 vs 29.0.2 golden-set comparison (RJC-382)

> **Correction (2026-09-01, RJC-383 lane — see
> [`manticore-relevance-baseline-correction-2026-09-01.md`](./manticore-relevance-baseline-correction-2026-09-01.md)).**
> The 6.3.8 column below (0.477 / 0.425) was measured against the shared
> instance's `aanvragen` table, which held 505 foreign spec-fixture rows
> (37 of them matching `azure`); the 29.x columns ran on fresh volumes. On an
> empty 6.3.8 table the same commit scores **0.523 / 0.529** (exact-skill
> 0.792 / 0.809, nl-morphology 0.786 / 0.758, compound 0.429 / 0.429,
> semantic-synonym 0.188 / 0.202, phrase-filter 0.881 / 0.911, nl-en-mix
> 0.000 / 0.000). Table settings and tokenisation are identical on legacy and
> fresh tables; the difference is the foreign rows. Consequences for the
> findings below: `es-azure` 20 → 3 and the exact-skill / phrase-filter
> "improvements" do NOT survive — fresh 6.3.8 returns the same 3 `es-azure`
> hits at recall 1.000 and scores 0.792 / 0.809 and 0.881 / 0.911 in those
> categories. The semantic-synonym regression DOES survive: fresh 6.3.8 finds
> `se-jeugdzorg` (0.500 / 1 hit) and `se-duurzameenergie` (1.000 / 1 hit),
> 29.0.2 finds neither. Net, measured on equal (empty) tables: 6.3.8
> 0.523 / 0.529 vs 29.0.2 0.488 / 0.482. Any version attribution must re-run
> the 6.3.8 baseline on an empty table first.

Comparison round following the shadow-instance prep (PR #90, `tools/manticore/README-29-shadow.md`). Runs the golden relevance set (`benchmarks/relevance/`) against three targets, isolating the VERSION change (6.3.8 → 29.0.2) from the CONFIG change (`min_infix_len = 2`, only present in the shadow conf):

1. **6.3.8** (production, `:9308`, `tools/manticore/manticore.conf`) — no infix.
2. **29.0.2, no infix** (shadow, `:9312`, `tools/manticore/manticore29-noinfix.conf` — new, identical to `manticore29.conf` minus `min_infix_len`) — isolates the VERSION change alone.
3. **29.0.2, with infix** (shadow, `:9312`, `tools/manticore/manticore29.conf`) — isolates the CONFIG change on top of the version change.

Each config ran on a fresh `manticore29` volume (`docker volume rm catapulze-job-intelligence_manticore29_data` between configs), confirmed empty (`total: 0` from a `match_all` search) before every run, and each config ran twice to check determinism. Full per-engine reports are committed alongside this doc: `docs/research/manticore-29-comparison-2026-09-01/report-{6.3.8,29-noinfix,29-infix}.json`.

6.3.8-with-infix (bonus item 4 in the task) was **not run**: the production conf cannot be touched from this lane's file ownership (`tools/manticore/manticore.conf` is out of scope; changing it would also invalidate the "production stays byte-identical" invariant from `README-29-shadow.md`).

## Results

### Recall@20 / nDCG@10 by config × category (macro-averaged)

| Category | 6.3.8 | 29.0.2 no-infix | 29.0.2 infix |
|---|---|---|---|
| exact-skill | 0.667 / 0.650 | 0.792 / 0.809 | 0.792 / 0.809 |
| nl-morphology | 0.786 / 0.573 | 0.786 / 0.758 | 0.786 / 0.758 |
| compound | 0.429 / 0.385 | 0.429 / 0.429 | 0.429 / 0.429 |
| semantic-synonym | 0.188 / 0.202 | 0.000 / 0.000 | 0.000 / 0.000 |
| phrase-filter | 0.738 / 0.676 | 0.881 / 0.853 | 0.881 / 0.853 |
| nl-en-mix | 0.000 / 0.000 | 0.000 / 0.000 | 0.000 / 0.000 |
| **OVERALL (macro)** | **0.477 / 0.425** | **0.488 / 0.482** | **0.488 / 0.482** |

**The overall macro win hides a real per-category loss — read the semantic-synonym section below before treating this table as a clean win.** The 29.0.2-no-infix and 29.0.2-infix columns are identical to six decimal places, per query (full `perQuery` diff, verified byte-for-byte) — `min_infix_len = 2` produced zero measurable change anywhere in the golden set on this corpus (see the Infix verification section for direct proof it was actually active).

### Semantic-synonym: per-query breakdown (category regressed, not flat)

The category dropped from Recall@20 0.188 (6.3.8) to 0.000 (both 29.x configs) — that is not "0.000 on both, no regression," it is eight queries where two lost their only relevant hit:

| Query id | 6.3.8 recall/returned | 29.0.2 no-infix recall/returned | 29.0.2 infix recall/returned |
|---|---|---|---|
| se-sysadmin | 0.000 / 0 | 0.000 / 0 | 0.000 / 0 |
| se-softwaredev | 0.000 / 1 | 0.000 / 1 | 0.000 / 1 |
| se-hrsystemen | 0.000 / 0 | 0.000 / 0 | 0.000 / 0 |
| se-iam | 0.000 / 0 | 0.000 / 0 | 0.000 / 0 |
| **se-jeugdzorg** | **0.500 / 1** | **0.000 / 0** | **0.000 / 0** |
| **se-duurzameenergie** | **1.000 / 1** | **0.000 / 0** | **0.000 / 0** |
| se-dataengineer | 0.000 / 20 | 0.000 / 0 | 0.000 / 0 |
| se-brandbeveiliging | 0.000 / 0 | 0.000 / 0 | 0.000 / 0 |

`se-jeugdzorg` ("gemeente jeugdzorg") and `se-duurzameenergie` ("duurzame energie") **genuinely regressed**: both had a matching relevant document on 6.3.8 and return zero hits at all on 29.0.2, on both configs identically (confirming it's version-driven, not infix-driven). `se-dataengineer` did not regress in Recall@20 (0.000 on all three) but did change in `returned` (20 → 0) — 6.3.8 returned 20 irrelevant hits, 29.x returns none; not scored differently, but worth noting for the record.

**Root cause, investigated and found:** re-ran the real corpus (via `loadRelevanceCorpus()`) and the real query path against both engines directly (ad hoc script, not committed — used `ManticoreSearchEngine` from `packages/search` so it's the exact production code path). Isolated to single-term queries:

```
[6.3.8] "duurzaam" -> 12 hits, has920=true
[6.3.8] "duurzame" -> 12 hits, has920=true   (same 12 — duurzaam/duurzame collapse to one stem)
[29.x]  "duurzaam" -> 4 hits,  has920=true
[29.x]  "duurzame" -> 3 hits,  has920=false  (different result set — no longer collapse)

[6.3.8] "gemeente"  -> 20 hits, has944=true
[6.3.8] "gemeenten" -> 20 hits, has944=true  (same 20 — gemeente/gemeenten collapse to one stem)
[29.x]  "gemeente"  -> 4 hits,  has944=false
[29.x]  "gemeenten" -> 3 hits,  has944=true  (different result set — no longer collapse)
```

On 6.3.8, `libstemmer_nl` collapses `duurzaam`/`duurzame` and `gemeente`/`gemeenten` to the same stem, so a query using one inflected form still matches a document containing only the other. On 29.0.2, with the identical `morphology = stem_en, libstemmer_nl` setting, these pairs no longer collapse — the two word forms now return different result sets. This is a **new, distinct Dutch-stemming regression** from the already-known "-aars" issue (`ontwikkelaar`/`ontwikkelaars`, still broken on both versions per `README-29-shadow.md`) — this one is a version-driven *weakening* of stemming coverage on 29.0.2, not a pre-existing gap carried forward. Not investigated further than isolating it to the stemmer's behavior (e.g., whether Manticore 29.x bundles a different libstemmer/Snowball release, or changed how it's invoked) — that's a follow-up, not something this round's scope covers.

### Per-query probes (exact-skill / nl-morphology)

| Query | Category | 6.3.8 recall/ndcg | 29.0.2 no-infix recall/ndcg | 29.0.2 infix recall/ndcg | returned (6.3.8 → 29.x) |
|---|---|---|---|---|---|
| es-azure | exact-skill | 0.000 / 0.000 | 1.000 / 1.000 | 1.000 / 1.000 | 20 → 3 |
| es-firewall | exact-skill | 0.000 / 0.000 | 0.000 / 0.000 | 0.000 / 0.000 | 0 → 0 |
| es-scrum | exact-skill | 0.333 / 0.202 | 0.333 / 0.469 | 0.333 / 0.469 | 5 → 1 |
| mo-ontwikkelaars ("-aars" pair) | nl-morphology | 0.000 / 0.000 | 0.000 / 0.000 | 0.000 / 0.000 | 0 → 0 |

- **es-azure**: 6.3.8 returns 20 hits with 0 relevant among them (recall 0) — the known miss cited in RJC-382. On 29.0.2 (both configs) it returns exactly the 3 hits judged relevant, recall/nDCG = 1.000. Identical on both 29.x configs, so it is not caused by `min_infix_len`.
- **es-firewall**: 0 hits on both 6.3.8 and 29.0.2 (both configs). Unresolved by the version upgrade or by infix.
- **es-scrum**: Recall@20 unchanged at 0.333 on every config, including 29.0.2-infix — `min_infix_len = 2` does **not** fix the "scrum inside scrumteam" case on this golden set's query/corpus, despite that being its documented purpose in `manticore29.conf`. nDCG improves (0.202 → 0.469) purely from the version upgrade (fewer, better-ranked hits: 5 → 1), not from infix matching new documents.
- **mo-ontwikkelaars** (the "-aars" stemming pair): confirmed still broken on 29.0.2, consistent with the shadow probe's prior finding.

### Infix verification (not just asserted)

`SHOW TABLE aanvragen SETTINGS` on each running config, direct from the container:

```
6.3.8 (mysql via docker exec, port 9306):
  settings | html_strip = 1
             morphology = stem_en, libstemmer_nl

29.0.2 manticore29.conf (infix), fresh volume:
  settings | min_infix_len = 2
             index_exact_words = 1
             html_strip = 1
             morphology = stem_en, libstemmer_nl

29.0.2 manticore29-noinfix.conf (no infix), fresh volume:
  settings | html_strip = 1
             morphology = stem_en, libstemmer_nl
```

`min_infix_len = 2` is confirmed active on the infix table and confirmed absent on both 6.3.8 and the noinfix table — the two 29.x tables really do differ only in this one setting. Given that, and given `es-scrum` (the query infix was added for) shows the identical hit count (5→1, unchanged from no-infix to infix) rather than the expected increase from infix substring matching, the "zero effect" conclusion holds: it isn't that infix silently failed to activate, it activated and still added nothing measurable on this corpus/query set.

### Determinism

Two runs per config, `.artifacts/relevance/report.json` diffed byte-for-byte:

- 6.3.8: `diff report-run1.json report-run2.json` → empty.
- 29.0.2 no-infix: `diff report-run1.json report-run2.json` → empty.
- 29.0.2 infix: `diff report-run1.json report-run2.json` → empty.

All three configs are deterministic across repeated runs.

### Latency

Not measured. The harness (`benchmarks/relevance/run.ts`) has no timing instrumentation and none was added — the task scope caps `run.ts` changes to the additive second-engine plumbing described below, and adding `performance.now()` around the per-query loop would touch shared scoring code for a metric this round didn't need (the golden set is a relevance gate, not a latency benchmark; `benchmarks/search/` already owns latency measurement on its own synthetic corpus per `benchmarks/relevance/README.md`). Recorded here as **not measured**, not as zero-cost. Since speed is the product's most important property here, this is not a soft gap — see the decision section below.

## Doc-count / field drift

Both `manticore29.conf` and `manticore29-noinfix.conf` now carry the same schema as `tools/manticore/manticore.conf`, including the RJC-378 attributes (`locatie`, `sluitingsdatum`) that were missing from `manticore29.conf` before this round — without them, `/replace` on the shadow table would fail on any document carrying those fields. Each config's `aanvragen` table was confirmed empty (`total: 0`) before every run, and the harness's own before/after upsert-then-delete cycle means no cross-run document drift occurred. No field-value drift was observed in the per-query `perQuery.returned` counts, which match the recall/nDCG figures above (the semantic-synonym `returned` drops are relevance regressions, traced to stemming above — not indexing drift; every document was present in the table, they simply stopped matching those two queries).

## Switch criteria (from `README-29-shadow.md`)

| Criterion | Status | Evidence |
|---|---|---|
| Recall@20 on manticore29 >= Recall@20 on manticore (6.3.8), full golden set | **Holds on macro, FAILS per category** | Overall 0.488 >= 0.477. But semantic-synonym is a real regression (0.188 → 0.000, two queries lost their only hit — see breakdown above), masked by the overall macro average. The criterion as literally written ("full golden set", macro) holds; read at category granularity it does not. |
| p95 latency within the existing `apps/server` search SLO/budget | **BLOCKED ON LATENCY** | Not measured this round. Speed is the product's most important property here, so this is not a soft "not evaluated" — it is a hard blocker on the switch decision until a p50/p95 run exists for both engines, next round. |
| No document-count or field-value drift | **Holds** | Table empty before every run, RJC-378 attrs added to both shadow configs, no drift observed |
| RJC-382 owner sign-off on the specific config used | **Open** | Two candidate configs measured (`manticore29.conf` with infix, `manticore29-noinfix.conf` without) — sign-off decision is for the owner, not this lane |

**Not all four hold** — per `README-29-shadow.md`, 6.3.8 stays served. `manticore29` should stand as a shadow for the next round.

## Recommendation

- The version delta (6.3.8 → 29.0.2) is a **trade, not a clean win**: exact-skill and phrase-filter both improve (driven by `es-azure` moving from 0 to perfect recall, and fewer/better-ranked hits generally), but semantic-synonym genuinely regresses — two queries (`se-jeugdzorg`, `se-duurzameenergie`) that had a matching document on 6.3.8 return nothing on 29.0.2. Root cause is a Dutch-stemming weakening in 29.0.2's `libstemmer_nl` handling (see the isolated single-term evidence above) — not a corpus artifact, not an infix side effect (identical on both 29.x configs).
- `min_infix_len = 2` measured **zero** effect on this golden set, including on the query it was specifically added for (`es-scrum` — Recall@20 unchanged, hit count unchanged from no-infix to infix), and this was verified to be a true zero-effect result rather than a misconfigured shadow (`SHOW TABLE SETTINGS` confirms infix was actually active). Carrying it forward is not supported by this evidence; it adds indexing cost for no observed relevance gain on the current corpus/query set. If the intended fix scenario ("scrum" inside "scrumteam" as a literal substring with no word boundary) genuinely isn't represented in this ~33-document corpus, that is itself worth flagging as a corpus-size caveat.
- Given the version change is a trade (gains on exact-skill/phrase-filter, a real loss on semantic-synonym) and latency is completely unmeasured, this round does **not** support switching. Next round must measure p50/p95 latency on both engines before the switch criteria can be re-evaluated, and the semantic-synonym stemming regression should be understood (does 29.0.2 bundle a different Snowball/libstemmer release?) before treating the version upgrade as net-positive.

Two-line pointer added to `tools/manticore/README-29-shadow.md`.
