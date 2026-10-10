# Search latency benchmark

Measures **SearchAdapter latency only** (p50/p95/p99) against a generated, meaningless-for-relevance corpus. This is deliberately separate from `benchmarks/relevance/`, which measures relevance on real fixture documents — never use this corpus for a relevance claim, and never use that one for a latency claim.

## Run it

```bash
bun run bench:generate                          # writes fixtures/search/benchmark-corpus.jsonl (200k docs, default seed)
bun run bench:search                             # in-memory engine
MANTICORE_URL=http://127.0.0.1:9308 bun run bench:search   # + local Manticore
```

Output: a single JSON report (`p50Ms`/`p95Ms`/`p99Ms`/`passed` against `profile.json`'s SLO).

## RJC-382: comparing a second Manticore engine

Set `MANTICORE_29_URL` (optionally `MANTICORE_29_LABEL`) to also measure a second Manticore instance — e.g. the `manticore29` shadow — in the same invocation, mirroring the pattern in `benchmarks/relevance/run.ts`:

```bash
MANTICORE_URL=http://127.0.0.1:9308 \
MANTICORE_29_URL=http://127.0.0.1:9312 \
MANTICORE_29_LABEL=manticore29-noinfix \
bun run bench:search
```

This switches to an extended report (a JSON array, one object per engine) that adds `documentCount`, `errorCount`, `indexingDocsPerSecond`, `indexingMs`, and `maxMs` alongside the usual latency fields. The default single-engine invocation (neither `MANTICORE_29_URL` nor `LATENCY_GOLDEN_QUERIES` set) is untouched — same report shape as before.

With `SEARCH_HYBRID=1`, the extended round runs 6.3.8 lexical, 29 lexical, and 29 hybrid as three isolated series. The 29 table is cleaned and proven empty before it is reused, including its combined `aanvragen_bench` logical table. Both 29 modes enable the vector schema while query mode remains an independent lexical/hybrid choice; 6.3.8 keeps the legacy partition-only schema. The evaluation applies the decision-specific 50 ms p95 budget to lexical series and 200 ms to hybrid. The report's `searchMode` identifies the path. `embeddingDocsPerSecond` reports the indexing rate when the 29 auto-embedding vector schema generated an embedding for every document, and is `null` otherwise.

Manticore runs use dedicated `aanvragen_bench_active` / `aanvragen_bench_archive` tables. Before the non-atomic empty-table preflight, extended comparison runs atomically claim a local per-endpoint lock shared across worktrees. The runner then requires a strict canonical nonnegative integer from a real `SELECT COUNT(*)`, deletes only its UUID-scoped document IDs in `finally`, and requires both tables to count zero afterward. CI also sets `BENCH_REQUIRE_MANTICORE=1`, so a missing URL cannot silently turn the Manticore lane into an in-memory run. The runner never writes to or cleans production search tables.

## RJC-382: golden-query mode

Set `LATENCY_GOLDEN_QUERIES=1` to run the 43 real queries from `benchmarks/relevance/queries.jsonl` through the same timing loop instead of `profile.json`'s 5 synthetic queries — `SearchAdapter`'s own defaults (facets on, `sort=relevance`, `limit=20`) already match the production request shape (post RJC-378), so this only swaps the query set, not the call parameters. Combine with `MANTICORE_29_URL` to golden-query both engines in one run. See `docs/research/manticore-latency-2026-09-01.md` for a worked comparison round.

## Corpus ids and concurrent runs

Generated corpus ids remain stable in the input and report. For Manticore, the runner adds a fresh run-scoped UUID suffix to every indexed id so concurrent invocations cannot overwrite or delete each other's documents. Cleanup is limited to the exact scoped ids owned by that invocation.
