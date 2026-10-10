# Manticore relevance baseline correction (2026-09-01)

Found while landing RJC-383 (active/archive split): the RJC-382 comparison's
6.3.8 column (0.477 / 0.425, `docs/research/manticore-29-comparison-2026-09-01.md`,
also quoted in Linear) was produced against the shared instance's `aanvragen`
table while that table held 505 foreign rows; the 29.x columns ran on fresh,
empty volumes. The two sides of that comparison were not measured under the
same conditions.

**Why the table looked empty:** the emptiness probe was a `/search` with
`"limit": 0`, whose `hits.total` reflects the returned window, not the table
— it reports 0 on a 505-row table. `SELECT COUNT(*) FROM aanvragen` over
`/sql?mode=raw` returns 505. `bun run relevance` now refuses non-empty
tables using the latter.

## What the shared `aanvragen` table contains

`SHOW TABLE aanvragen STATUS` on `:9308` (2026-09-01):
`indexed_documents = 505`, `killed_documents = 51506` (`killed_rate = 99.02%`),
`disk_chunks = 0`. The 505 live rows are spec fixtures that were never removed
(ids `perm-doc-a-<uuid>`, `perm-doc-b-<uuid>`, `not-doc-only-a-<uuid>`,
`not-doc-both-<uuid>` — `packages/search/src/adapter.spec.ts:445-525` — plus
three UUID rows, titles "Platform engineer Azure", "Azure Cloud Engineer -
cluster BCO", "Softwarebroker"). `SELECT count(*) FROM aanvragen WHERE
MATCH('azure')` = 37 before any corpus document is inserted.

## Settings are identical (hypothesis "stale table settings" refuted)

`SHOW CREATE TABLE aanvragen` and `SHOW CREATE TABLE aanvragen_active` are
byte-identical apart from the name: same 14 columns,
`html_strip='1' morphology='stem_en, libstemmer_nl'`, no `min_infix_len`.
`CALL KEYWORDS('azure', <table>, 1)` normalises to `azur` on both;
`ontwikkelaars` → `ontwikkelaar`, `scrumteam` → `scrumteam` on both.

Golden corpus (33 docs) inserted into BOTH tables, then
`SELECT document_id ... WHERE MATCH('azure')`:

| table | matches among corpus ids | foreign matches |
|---|---|---|
| `aanvragen` (legacy, 505 foreign rows) | `bluetrail:opdrachten/Interim/systeembeheerder`, `pro-act:vacatures/senior-azure-operations-engineer-8793`, `tenderned:TN563214` | 37 |
| `aanvragen_active,aanvragen_archive` (fresh) | same three | 0 |

Corpus match sets are identical. The legacy top-20 for `azure` is
2 corpus + 17 foreign + 1 corpus (position 5) — i.e. the "20 returned,
0 relevant" that RJC-382 attributes to 6.3.8 is `LIMIT 20` filled by fixture
rows titled "Platform engineer Azure" outranking the three judged documents.

## Numbers: legacy vs fresh, in-memory vs Manticore

Same code (`cf7c234`, the RJC-382 baseline commit), same corpus, same query
set. "Fresh" = an empty 6.3.8 (`manticoresearch/manticore:6.3.8`, production
conf), verified `count(*) = 0` before the run.

| engine | table state | Recall@20 / nDCG@10 |
|---|---|---|
| in-memory | n/a | 0.457 / 0.465 |
| Manticore 6.3.8 | legacy `aanvragen`, 505 foreign rows | **0.477 / 0.425** (= RJC-382's 6.3.8 column, reproduced) |
| Manticore 6.3.8 | fresh, empty | **0.523 / 0.529** |
| Manticore 6.3.8 | fresh, empty, `main 98d681c` | 0.523 / 0.529 (identical per query) |
| Manticore 6.3.8 | fresh, empty, RJC-383 split (`scope=all`) | 0.523 / 0.529 (identical per query) |

Fresh-6.3.8 per category (Recall@20 / nDCG@10): exact-skill 0.792 / 0.809,
nl-morphology 0.786 / 0.758, compound 0.429 / 0.429, semantic-synonym
0.188 / 0.202, phrase-filter 0.881 / 0.911, nl-en-mix 0.000 / 0.000.

## Per query, the ones RJC-382 leans on

| query | 6.3.8 legacy (RJC-382) | 6.3.8 fresh | 29.0.2 (both confs) |
|---|---|---|---|
| es-azure | 0.000 / returned 20 | 1.000 / returned 3 | 1.000 / returned 3 |
| se-jeugdzorg | 0.500 / returned 1 | 0.500 / returned 1 | 0.000 / returned 0 |
| se-duurzameenergie | 1.000 / returned 1 | 1.000 / returned 1 | 0.000 / returned 0 |
| se-dataengineer | 0.000 / returned 20 | 0.000 / returned 0 | 0.000 / returned 0 |

## What this does to the RJC-382 conclusions

- `es-azure` 0 → 3/3 on 29.x: not a version effect. Fresh 6.3.8 returns the
  same 3 hits with recall 1.000.
- exact-skill 0.667 → 0.792 and phrase-filter 0.738 → 0.881 "improvements" on
  29.x: not version effects. Fresh 6.3.8 scores 0.792 / 0.809 and
  0.881 / 0.911 — equal or higher.
- semantic-synonym regression (`se-jeugdzorg`, `se-duurzameenergie` returning
  0 hits on 29.0.2): survives. Fresh 6.3.8 still finds both (0.500 / 1.000);
  29.0.2 finds neither.
- Overall: fresh 6.3.8 0.523 / 0.529 vs 29.0.2 0.488 / 0.482. Per category,
  29.0.2 is equal to fresh 6.3.8 everywhere except semantic-synonym, where it
  regresses (se-jeugdzorg, se-duurzameenergie); the macro gap is that
  regression. The decision remains the owner's.

## Operational consequence

`bun run relevance` with `MANTICORE_URL` set writes into the app's live
tables (`aanvragen` before RJC-383; `aanvragen_active`/`aanvragen_archive`
after). It removes only the documents it inserted. Any pre-existing row takes
ranking slots and skews BM25 statistics. Relevance numbers are only
comparable when the target tables are empty (`SELECT count(*)` = 0) at the
start of the run — recorded in `benchmarks/relevance/README.md`. The 505
fixture rows on the shared instance come from specs; clearing them is an
operator action, not something this branch does. Structural fix (RJC-400): live specs now target dedicated `aanvragen_test_*` tables; benches keep `aanvragen_bench_*`; `bun run check:manticore-bench-empty` proves the bench tables empty before a relevance run when `MANTICORE_URL` is set.
