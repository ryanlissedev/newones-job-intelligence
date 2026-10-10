# Golden relevance benchmark

> **RJC-400 table roles.** Live `MANTICORE_URL` specs write only to `aanvragen_test_active` / `aanvragen_test_archive`. Relevance and search benches use `aanvragen_bench_*`. Production `aanvragen*` tables are never test scratch space. Gate/CI can prove the bench tables empty via `bun run check:manticore-bench-empty` (SELECT COUNT(*), never `/search` limit:0).

Measures **search relevance** (does the engine return the right assignments?) for any `SearchEngine` implementation, on real documents. This is the gate in front of any engine migration (`.isa/search-quality.md`, ISC-7): no engine migrates until this benchmark points at a winner. It is deliberately separate from `benchmarks/search/`, which measures **latency only** on a synthetic, meaningless corpus — that corpus must never be used for relevance claims.

## Run it

```bash
bun run relevance                                        # in-memory engine only
MANTICORE_URL=http://127.0.0.1:9308 bun run relevance    # + local Manticore
```

Output: a per-category table of Recall@20 and nDCG@10 per engine, plus a deterministic JSON report at `.artifacts/relevance/report.json` (no timestamps — two runs on the same corpus produce byte-identical files).

For the Manticore 29 hybrid decision, one invocation measures the three isolated candidate modes (plus the existing in-memory floor):

```bash
SEARCH_HYBRID=1 \
MANTICORE_URL=http://127.0.0.1:9308 \
MANTICORE_29_URL=http://127.0.0.1:9312 \
bun run relevance
```

This adds `manticore-6.3.8-lexical`, `manticore-29-lexical`, and `manticore-29-hybrid`. The 29 modes run sequentially, with the mandatory empty-table proof across `aanvragen_bench`, `aanvragen_bench_active`, and `aanvragen_bench_archive`, plus run-scoped cleanup between them. The combined logical table is populated only for the 29 vector schema; 6.3.8 continues to use and inspect only its two partition tables. Volatile p50/p95 query latency for the default active scope and indexing throughput are written separately to `.artifacts/relevance/performance.json`, preserving the deterministic contract of `report.json`. Relevance documents use one stable benchmark scope so the numeric Manticore ID tie-break is identical across engines and repeated runs. Before the non-atomic empty-table preflight, the runner atomically claims a local per-endpoint lock shared across worktrees; a concurrent invocation fails closed instead of overwriting the stable IDs. For either 29 mode, `embeddingDocsPerSecond` is the measured indexing rate because the vector-schema table creates an auto-embedding for each indexed document; it is `null` for schemas without auto-embeddings.

## What it measures, and why these metrics

- **Recall@20 (primary).** A missed assignment is a missed deal: the product cost of a relevant aanvraag not appearing on the first page dominates every other ranking concern. MRR is unsuitable because most queries have several correct answers, not one; P@k unfairly punishes queries with few relevant documents in a small corpus.
- **nDCG@10 (secondary).** Among engines with equal recall, the one that puts relevant documents higher wins. Binary gains (relevant = 1).

Both are macro-averaged over queries, so a category with few queries is not drowned out.

## The corpus

`corpus.ts` builds documents from the real capture fixtures under `fixtures/connectors/` by running each source's **real connector (fixture mode) and real normaliser** — the same discover → fetch → normalise path production ingestion uses. Nothing is retyped or invented. The corpus is small (~33 documents, one listing capture per source); that is an honest v1 limitation, not a defect to be padded over with synthetic text. Connector rejections (e.g. Flinter's permanent-vacancy guard) are reported as skips, not silently dropped.

To grow the corpus, replace `loadRelevanceCorpus` with a loader over a larger real dump (e.g. the Motian backfill). The runner consumes only `RelevanceCorpusDocument[]`, so the query set and metrics code do not change — but judgments must then be re-pooled (see below), because recall is only meaningful against a corpus whose relevant documents are all labeled.

## The query set (`queries.jsonl`)

One JSON object per line:

```json
{
  "id": "es-azure",
  "category": "exact-skill",
  "query": "azure",
  "filters": {},
  "relevant": ["..."],
  "hardNegatives": ["..."],
  "note": "optional judgment rationale"
}
```

- ~41 Dutch queries across six categories: `exact-skill`, `nl-morphology` (ontwikkelaar/ontwikkelaars), `compound` (frontendontwikkelaar), `semantic-synonym`, `phrase-filter`, `nl-en-mix`. Some categories are thin because the corpus is thin; every query is answerable from the real corpus.
- `relevant`: binary judgments — document ids a searcher issuing this query would want to see.
- `hardNegatives`: documents that superficially look relevant (shared stem, adjacent domain) but were judged irrelevant. They document the judgment boundary and keep future annotators honest; they do not enter the score.
- `filters`: optional `SearchFilters` for the `phrase-filter` category.
- No recruiter names, e-mail addresses, or phone numbers anywhere (ISC-8).

### Judgment provenance and labeling procedure

v1 judgments are **single-annotator** (made by reading every corpus document in full; borderline calls carry a `note`). To add or re-judge queries:

1. Pool candidates: run the query through every available engine plus a plain keyword scan over titles/descriptions; the union is the candidate pool. Judge every pooled document, not just the ones an engine returned.
2. Judge binary relevance from the document text alone ("would a searcher issuing this query want this assignment?") — never from what any engine ranked, and never from knowledge not present in the document.
3. Record judged-irrelevant lookalikes as `hardNegatives` with a `note` for anything borderline.
4. Keep every query at ≥1 relevant and ≥1 hard negative (the runner enforces this), and keep ids stable — scores are only comparable across runs if the query set version is identical.

When a second annotator joins, disagreements resolve by discussion and the resolution is recorded in the query's `note`; measure inter-annotator agreement before trusting fine-grained nDCG differences.

## Engines

The runner talks only to the `SearchEngine` seam (`packages/search`):

- **in-memory** — always runs; the floor. Its "ranking" is lexicographic id order with substring matching, so treat its nDCG as a baseline artifact.
- **manticore** — runs when `MANTICORE_URL` is set and always targets the dedicated `aanvragen_bench_active` / `aanvragen_bench_archive` tables. Ordinary runs assign UUID-scoped document ids. The three-mode relevance comparison instead uses a stable scope for reproducible numeric-id tie-breaking and therefore holds an atomic per-endpoint lock for its full preflight/index/score/cleanup lifecycle. Results map back to stable corpus ids before scoring, cleanup deletes only the selected scope, and both dedicated tables must be empty before and after the run. The runner never writes to or cleans production search tables.

  Scoring runs twice per engine: `scope: "all"` (both partitions, the number comparable with pre-split history — printed first and stored under `engines`) and `scope: "active"` (the default search space; stored under `enginesActiveScope`).

Adding a candidate engine = one entry in `buildEngineRuns` in `run.ts` (construct anything implementing `SearchEngine`). No application-layer code changes (ISC-4).

## RJC-382: comparing against a second engine

Set `MANTICORE_29_URL` (and optionally `MANTICORE_29_LABEL`) to score a second Manticore target in the same run — used to compare the 6.3.8 production instance against the 29.0.2 shadow instance (`tools/manticore/README-29-shadow.md`):

```bash
MANTICORE_URL=http://127.0.0.1:9308 \
MANTICORE_29_URL=http://127.0.0.1:9312 \
MANTICORE_29_LABEL=manticore29-infix \
bun run relevance
```

Run once against `tools/manticore/manticore29.conf` (infix enabled) and once against `tools/manticore/manticore29-noinfix.conf` (identical minus `min_infix_len`) to isolate the infix config change from the version upgrade itself. Use a separately provisioned benchmark instance for each configuration. The runner verifies the dedicated benchmark tables are empty with `SELECT COUNT(*)` over `/sql?mode=raw` before and after each run; this cleanliness gate is mandatory and has no dirty-table override.

## Judgments: extending the golden set with real recruiter judgments

`export-judgments.ts` and `import-judgments.ts` turn re-judging into a one-sitting recruiter task instead of hand-editing `queries.jsonl`.

```bash
bun run relevance:export                                       # -> benchmarks/relevance/judgments/<today>.csv (+ .md twin)
bun run relevance:export -- --out path/to/file.csv --pool-depth 20
bun run relevance:import -- --file <csv> --grader "<name>" --dry-run
bun run relevance:import -- --file <csv> --grader "<name>"
```

**Export** pools, per query, the union of every configured engine's top-N (in-memory always; Manticore/Manticore-29 when `MANTICORE_URL`/ `MANTICORE_29_URL` are set — same engines `bun run relevance` scores) plus every document already labeled `relevant` or `hardNegative`, so a recruiter can confirm or revoke an existing label even if no engine still surfaces it. Output is a `;`-delimited CSV (Dutch Excel default, UTF-8 with a BOM) with an empty `grade` column, plus an `.md` twin for reading in a browser or Linear. Two exports on an unchanged corpus/query set are byte-identical. See `judgments/README.md` for the recruiter-facing instructions (in Dutch).

`export-judgments.ts` exports `exportJudgments({ outPath, poolDepth, queriesPath })` so the export can run in-process; the CLI is a thin argv wrapper over it. The spec uses the in-process form for the byte-identical check and keeps one spawned smoke run with an explicit budget — see `docs/runbooks/gate-flaky-tests.md` for why.

**Import** folds graded rows back: grade ≥ 1 adds the doc to `relevant` (and removes it from `hardNegatives` if present); grade 0 does the reverse. Unknown query/doc ids and conflicting grades for the same doc (unless `--prefer-latest`) both refuse with a listing and exit non-zero, before anything is written. Only `relevant`/`hardNegatives` on touched queries change — every other line in `queries.jsonl` is byte-identical, and key order is preserved on touched lines too. `--queries <path>` / `--provenance <path>` override the two files the import reads and writes (default: the real committed `queries.jsonl` and `judgments/provenance.jsonl`) — used by the test suite to operate on a `mkdtemp` copy so a test run can never touch the golden set on disk.

A grade of `0` on a query's only `relevant` document would leave it with zero — `run.ts`'s `querySchema` requires `relevant.min(1)`, so the next `bun run relevance` would reject the whole golden set. The import refuses (exit 1, listing the affected queries) unless `--allow-empty-relevant` is passed. Even with that flag, the import only appends a `note` explaining the query is unscorable — it does **not** make `run.ts` accept it. **An engineer must re-pool that query (more candidates) or remove it before it scores again**; `--allow-empty-relevant` exists to let an import land without losing the other queries' judgments in the same CSV, not to make an empty `relevant` array safe to ship as-is. After such a write, both `relevance:import` and `relevance:export` are blocked too (they load `queries.jsonl` through the same schema, not just `bun run relevance`) until an engineer re-pools or removes the query.

**Provenance lives in `judgments/provenance.jsonl`, not in `queries.jsonl`.** `run.ts`'s `querySchema` is `z.object({...}).strict()`, so an unknown key (e.g. a `judgments` field per query) would make every future `bun run relevance` throw at parse time — and `run.ts` is out of scope for this change. Each import instead appends one line per touched query to `judgments/provenance.jsonl`: `{"queryId", "grader", "date", "source", "rows": [{"docId", "comment"}]}`.
