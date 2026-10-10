# Manticore 29.x shadow evaluation (RJC-382)

Production runs `manticoresearch/manticore:6.3.8` (`tools/manticore/manticore.conf`, compose service `manticore`). Upstream is at 29.x with native hybrid search (BM25 + KNN with RRF fusion, filters on both retrieval paths). The version gap is too large for an in-place upgrade, so this prepares a second instance to run side by side instead: `manticore29` (compose service, `tools/manticore/manticore29.conf`), pinned to `29.0.2` (`sha256:647ff5da4de6361eb043417a8f19b9e05041d3cfa1c3566665c07bc872cd15c3`) — the newest **stable** tag on Docker Hub as of 2026-08-31. Newer `dev-29.3.x` tags exist but are development builds, not release candidates; re-check Docker Hub before the comparison round in case a newer stable line has shipped by then.

The lexical comparison and the first hybrid successor round have now run. The hybrid candidate remains **off by default** because its measured laptop p95 is above the decision budget; see the 2026-09-03 result below and [`ADR-0009`](../../docs/adr/ADR-0009-manticore-29-hybrid.md).

## What's already proven (this lane)

`tools/manticore/probe-manticore29.sh` starts `manticore29`, creates the `aanvragen` table from the 29 conf schema, and confirms it accepts our insert/query shape: boolean filter, `GROUP BY` facet, morphology match, and infix match. See the lane's return message for the actual run output, including that the golden-set's `ontwikkelaar`/`ontwikkelaars` stemming split still reproduces on 29.0.2 — the changelog has no libstemmer/Dutch-stemming fix between 6.x and 29.x, so this needs to be tracked as still-broken, not assumed fixed by the upgrade.

## What this round does NOT do

- No real or production data. The probe uses throwaway fixtures and the evaluation uses the committed, seeded golden corpus.
- No 251k-corpus or Hetzner measurement. The result below is a laptop development measurement over 33 indexed documents and 43 queries.
- No traffic switch. `manticore29` stays a shadow target and `SEARCH_HYBRID` defaults to `0`.

## Shadow evaluation plan (next round)

1. **Reindex from Postgres.** Run whatever projector currently populates `aanvragen` on the 6.3.8 instance, pointed at `manticore29`'s HTTP port (`MANTICORE29_HTTP_PORT`, default `9312`) instead. Confirm document counts match between `manticore` and `manticore29` before scoring anything — a partial reindex will look like a relevance regression that isn't real.
2. **Run the golden set against both.** Same query set, same client, two targets (`manticore` on 9308, `manticore29` on 9312). Capture per-query results, not just aggregate scores, so a regression can be traced back to a specific query.
3. **Compare Recall@20 and latency.** Recall@20 is the primary relevance metric already used by the golden-set runner. Latency: p50/p95 per query type (boolean, facet, morphology-sensitive, infix-sensitive) — hybrid search and RRF fusion on 29.x carry different cost characteristics than the pure BM25 path on 6.3.8, so a latency regression on facet-heavy queries would not be surprising and needs its own budget, not the boolean-query budget.
4. **Decide fixes to actually test**, not just upgrade wholesale:
   - `min_infix_len = 2` (already enabled in `manticore29.conf`) — targets the confirmed "scrum inside scrumteam" miss on 6.3.8. Measure its Recall@20 delta and its index-size / indexing-latency cost before deciding to carry it forward.
   - Native hybrid search (BM25 + KNN + RRF) — only worth adopting if the golden set has queries where lexical-only search underperforms in a way vector retrieval would fix. Check golden-set query intent distribution first; don't build the KNN index path speculatively.
   - The `ontwikkelaar`/`ontwikkelaars` stemming split — confirmed still present on 29.0.2 (see probe output). This is not a reason to upgrade; it needs its own fix (custom stemming exceptions, or a wordforms file) regardless of which Manticore version ships.

## Switch criteria

Do not switch production traffic to 29.x unless **all** of the following hold, evidenced by the round-2 comparison, not by this prep round:

- Recall@20 on `manticore29` is >= Recall@20 on `manticore` (6.3.8) across the full golden set, not just the queries the new features target.
- p95 latency on `manticore29` is within the existing latency budget used by `apps/server` (check `packages/search` for the current SLO/budget value — do not invent a number here).
- No document-count or field-value drift between the two instances after reindex — a silent partial-index bug would otherwise masquerade as a relevance win.
- The RJC-382 owner has signed off on the specific config used for the comparison (this file's `manticore29.conf`, or a revision of it) — config changes made mid-comparison invalidate the result and require a rerun.

If any of these fail, keep 6.3.8 as the served instance and treat `manticore29` as a standing shadow for the next comparison round rather than tearing it down.

## Comparison round results (2026-09-01)

Golden-set Recall@20/nDCG@10 comparison, version isolated from the `min_infix_len` config change, is done: see `docs/research/manticore-29-comparison-2026-09-01.md`. Verdict: the version delta is a **trade, not a clean win** — macro Recall@20 rises (0.477 → 0.488) but semantic-synonym genuinely regresses (0.188 → 0.000, a real Dutch-stemming weakening in 29.0.2, not a corpus artifact); `min_infix_len = 2` measured zero effect (verified active via `SHOW TABLE SETTINGS`, not just assumed); latency is unmeasured and BLOCKED ON LATENCY for the switch decision (speed is the product's most important property); owner sign-off is still open. 6.3.8 stays served.

Latency round (2026-09-01): see `docs/research/manticore-latency-2026-09-01.md`. Both engines pass the p95 ≤ 100ms SLO on a generated 20k-document corpus under laptop contention; a true `manticore29-noinfix.conf` series could not be produced without touching the conf/compose mount (the conf-declared table definition reasserted itself over a same-name runtime `CREATE TABLE`) — only the as-mounted infix config was measured. Not a production-representative round (laptop, not Hetzner; synthetic corpus, not real Neon data).

## Hybrid successor round (2026-09-03)

The shadow configuration now uses Manticore 29.0.2 auto-embeddings:

```text
embedding FLOAT_VECTOR
KNN_TYPE=hnsw
HNSW_SIMILARITY=cosine
MODEL_NAME=Xenova/paraphrase-multilingual-MiniLM-L12-v2
FROM=titel,beschrijving
```

The approved Xenova ONNX model downloaded and ran locally; the `sentence-transformers/*` fallback was not used. Only the already-indexed `titel` and `beschrijving` fields feed the vector, preserving DEC-008 minimisation. `tools/manticore/wordforms-nl.txt` also carries the two narrow normalisations required by the measured misses:

```text
gemeenten > gemeent
duurzame > duurzaam
```

`gemeente` itself stems to `gemeent` on 29.0.2, hence the normalized target instead of the surface form. These entries repair the `gemeente jeugdzorg` and `duurzame energie` regressions; they are not a general Dutch linguistics strategy. A product/search owner still needs to own further wordforms, synonyms and morphology review.

Start the shadow and run the three isolated modes as follows:

```bash
docker compose --env-file .env.1password --profile shadow up -d manticore29

SEARCH_HYBRID=1 \
MANTICORE_URL=http://127.0.0.1:9308 \
MANTICORE_29_URL=http://127.0.0.1:9312 \
bun run relevance
```

For an end-to-end feature-flagged rebuild, the server and projector must use the same target and flag. First wait for the shadow healthcheck; then keep the projector stopped while following [`search-schema-migration.md`](../../docs/runbooks/search-schema-migration.md) through `bun run search:new-generation --apply`, start exactly one projector, drain, and run `bun run search:reconcile-projection` before serving queries. Inside Compose, the application definitions inject `MANTICORE_URL` and `SEARCH_HYBRID` directly into both processes. The root `bun run projector` command crosses Turbo strict environment filtering, so `turbo.json` explicitly allows `SEARCH_HYBRID` through to that task. Set `MANTICORE_URL=http://manticore29:9308` and `SEARCH_HYBRID=1` together. The normal defaults remain `http://manticore:9308` and `0`; never set the flag without switching and rebuilding the target generation.

The runner refuses non-empty benchmark tables before indexing and proves them empty after cleanup. For 29 it checks the synchronized logical table and both lifecycle partitions. Deterministic relevance output is written to `.artifacts/relevance/report.json`; volatile latency and throughput go to `.artifacts/relevance/performance.json`.

The full-scope golden-set result was:

| Category | 6.3.8 lexical | 29 lexical | 29 hybrid |
| --- | --: | --: | --: |
| exact-skill | 0.792 / 0.809 | 0.792 / 0.809 | 0.958 / 0.888 |
| nl-morphology | 0.786 / 0.705 | 0.786 / 0.705 | 0.971 / 0.882 |
| compound | 0.429 / 0.429 | 0.429 / 0.429 | 1.000 / 0.895 |
| semantic-synonym | 0.188 / 0.202 | 0.188 / 0.202 | 0.844 / 0.577 |
| phrase-filter | 0.833 / 0.869 | 0.833 / 0.811 | 0.952 / 0.890 |
| nl-en-mix | 0.000 / 0.000 | 0.000 / 0.000 | 1.000 / 0.731 |
| **Overall macro** | **0.516 / 0.514** | **0.516 / 0.505** | **0.951 / 0.809** |

Cells are Recall@20 / nDCG@10. Active-scope latency, sampled once per each of the 43 queries, was 1.57/2.42 ms p50/p95 on 6.3.8 lexical, 2.12/3.34 ms on 29 lexical, and 109.43/202.15 ms on 29 hybrid. Auto-embedding throughput was 1.4 docs/s in both 29 indexing passes.

The semantic, cross-language, exact-skill, phrase-filter and lexical-latency criteria pass. Hybrid p95 misses its 200 ms budget by 2.15 ms, so the switch criterion is **not met**. Keep `SEARCH_HYBRID=0` until a new clean run is within budget and the still-required 251k/Hetzner capacity round is complete.
