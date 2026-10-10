# Convex search slice — measured verdicts

Empirical measurement of Convex as a search engine for our aanvragen search surface, replacing the earlier docs-only judgment. Everything below is a number from a real run on 2026-08-31, or is explicitly labelled as extrapolation or gap.

## Setup (what was actually run)

- **Convex**: open-source local backend via `CONVEX_AGENT_MODE=anonymous npx convex dev` — anonymous local deployment on `127.0.0.1:3210`, **no account, no cloud, no credentials**. Schema + search index deployed in ~2.5s. Local state: `.convex/` (93MB for this 33-doc experiment) plus ~438MB of backend binaries in `~/.cache/convex`.
- **Corpus**: all 12 connector fixtures under `fixtures/connectors/` replayed through the **real** connectors and normalisers (`build-corpus.ts` uses `SOURCES[slug].createConnector` + `SOURCES[slug].normalise`, the same path `scripts/replay-run.ts` takes) → **33 documents** (bluetrail 2, ctm 5, flinter 1, harveynash 1, hero 2, inhuurdesk 2, needstaffing 1, onefellow 6, opdrachtoverheid 5, pro-act 2, striive 5, tenderned 1), avg **~5.3KB/doc**.
- **Surface approximated** (from `packages/search/src/manticore/client.ts`): text query over titel+beschrijving, the four terms facets (`bron_id`, `status`, `locatie_land`, `contracttype`), exact total, offset/limit, deterministic sort. Convex functions live in `convex/search.ts`.
- **Measurement**: `measure.ts` — 5 warmup + 50 timed iterations per query via `ConvexHttpClient` (HTTP to localhost; timings include HTTP overhead). `scale.ts` grows the table with clearly-marked duplicate documents to measure **cost scaling only** (never relevance). Raw numbers: `measurements.json`, `scale-measurements.json`.
- **Golden relevance set**: `benchmarks/relevance/queries.jsonl` from the parallel lane (branch `feat/search-golden-relevance-set`) was available — 43 queries, all 31 referenced document ids present in this corpus, run read-only against the slice.

Two schema-time forced moves worth naming before any numbers: a Convex search index has exactly **one searchField**, so titel+beschrijving are denormalised into an extra stored `zoektekst` field (text stored twice); and Convex queries have **no field projection** — every candidate the function touches is loaded in full, which is what makes the bytes-read limit below bite.

## Latency (33-doc corpus, local backend, p50/p95 over 50 iterations)

| Query                                         | p50       | p95       |
| --------------------------------------------- | --------- | --------- |
| Single-term search (8 terms, rare→broad)      | 0.2–0.6ms | 0.3–4.5ms |
| Search + facet filter (status+land)           | 0.6ms     | 4.8ms     |
| Pagination offset 0 / 20 / 100                | ~0.3ms    | 0.7–2.1ms |
| Boolean via JS post-filter                    | 0.3ms     | 1.2ms     |
| Full-scan facets (no term)                    | 0.2ms     | 0.6ms     |
| Golden-set query end-to-end (single run each) | 3.4ms     | 12.3ms    |

At 33 documents everything is comfortably inside the Manticore engine budget (p95 ≤ 100ms). This tells you almost nothing — the scaling section is where the story is. Ingest of 33 docs: 499ms in one batch mutation.

## Criterion 1 — Boolean text queries: **degraded** (native: impossible)

- Convex `.search()` has **no operators at all**: no AND, OR, NOT, no phrase queries (docs confirmed; measured). A multi-term query is match-any, ranked: `azure platform engineer` returned **8** documents where the real `(azure | "platform engineer") -intern` semantics has **3** — negation is simply not expressible and every extra term widens instead of narrows.
- The only route is a JS post-filter inside the query function (`booleanSearch` in `convex/search.ts`): feed positive terms to the index, re-apply AND/NOT in code. That reproduced the ground-truth 3/3 for `(azure OR "platform engineer") -intern` on this corpus — but the correctness is structurally fragile:
  - the candidate set is whatever the positive terms surface, capped at 1024 scanned results — any document ranked below that is **silently absent** from an AND/NOT answer, with no error;
  - at an 8,448-doc table the candidate fetch for a broad term **threw** (16MiB bytes-read limit, below) — so at scale the post-filter route doesn't degrade, it dies;
  - engine tokenization (whole-token + prefix-on-last-term) and any JS predicate must be kept hand-consistent: measured `adviseur -senior` divergence (engine 1 vs substring-predicate 2, the extra being "Beleids**adviseur**" — which token-based Manticore would also exclude, but which shows every boolean node needs its own tokenizer-faithful reimplementation in JS).
- Our Boolean parser emits a Manticore AST (`packages/search/src/manticore/ emitter.ts`); there is nothing to emit it _to_ in Convex.

**Verdict: the product's boolean surface cannot be delegated to Convex's search index; it becomes application code re-implementing an engine, with a hard silent-truncation ceiling.**

## Criterion 2 — Facets + exact totals: **degraded at fixture scale, impossible at production scale**

Convex has no aggregation primitive. Facet counts and exact totals both mean materialising every matching document into the function and counting in JS.

Measured, no-term facet render (`fullScanFacets`, full table scan):

| Table size | p50 | Outcome |
| --- | --- | --- |
| 33 | 0.9ms | correct buckets |
| 1,056 | 1.3ms | correct buckets |
| 2,112 | 0.7ms | correct buckets |
| 3,168 | — | **ERROR**: `Too many bytes read in a single function execution (limit: 16777216 bytes)` |
| 8,448 | — | **ERROR**: `Too many bytes read` (an earlier run surfaced this as a 1s query timeout instead — see below) |

`countAll` (exact total, no term) dies identically at 3,168. With our real ~5.3KB documents the 16MiB per-function read limit lands at **~3,100 documents — 0.04% of the documented 7.5M-doc corpus**.

Search-scoped facets (counts for the four dimensions under a query) are doubly capped: they can only ever see the ≤1024 scanned results (documented), and at the 8,448-doc table the candidate fetch for a term matching ~1.8k docs threw on bytes-read before the 1024 ceiling was even observable (undocumented — see below).

### Priced extrapolation to 7.5M docs

Pricing: convex.dev/pricing screenshot, Professional plan, US East, 2026-08-31 — search queries 50,000 query-GBs included then $0.10 per 1,000 query-GBs; database I/O 50 GB
included then $0.20/GB; function calls 25M included then $2/M; search storage 1 GB
included then $0.50/GB; database storage 50 GB included then $0.20/GB.

The bytes-per-doc figure is **measured, not assumed**: the full scan died at exactly the 16MiB read limit at a 3,168-doc table → 16,777,216 / 3,168 ≈ **5.3KB actually read per document** (independently matching the corpus average of 5,334 bytes/doc). At 7.5M docs one facet refresh therefore reads 7.5M × 5.3KB ≈ **40 GB**.

Meter classification (from the pricing categories; not verified against a real bill): `fullScanFacets` uses a plain table read (`ctx.db.query().collect()`), which is **database I/O**, not a search query; `searchPage`/`withSearchIndex` traffic is **search query-GBs**.

- **No-term facets (the browse page)** = full table scan = 40 GB database I/O per refresh → **~$8.00 per facet render** at $0.20/GB, and the 50 GB monthly free tier covers **one** refresh. 10,000 refreshes/month ≈ **$80,000/month** — before adding the
  ~2,500 chained function calls per refresh needed to stay under the 16MiB/call limit
  (~$0.005/refresh in function-call fees, ~12ms-per-call latency floor → tens of seconds per render).
- **Search-scoped facets** (≤1024 candidates) ≈ 5.4 MB of search query-GBs per query → ~$0.0005/query beyond free tier; the included 50,000 query-GBs cover ~9M such queries. Cheap — but the counts are mathematically wrong past 1024 matches, and the query itself threw at our measured ~1.8k-match / 8,448-doc point.
- **Storage** at 7.5M docs: ~40 GB raw fits the database-storage free tier; the search index over titel+beschrijving adds an estimated same-order tens of GB of search storage → ~$15–20/month (estimate, index overhead not measured).

So the dollar wall and the limit wall point the same way: correct search-scoped facets are impossible (1024 cap), and correct no-term facets are ~$8 and tens of seconds _per render_. Convex's own answer to counting is maintaining materialised counters (the aggregate/sharded-counter component pattern), which works for **predeclared** dimensions on the whole table but cannot produce facet counts scoped to an arbitrary user search — which is what our UI shows.

**Verdict: facets and exact totals as our product defines them are impossible at target scale. Manticore does all four aggs + exact total in the same single request as the hits.**

## Criterion 3 — Dutch morphology / stemming: **impossible**

No stemming, no language configuration (Tantivy `SimpleTokenizer`, whitespace/punctuation split, lowercase, 32-char terms; docs say "works best with English or other Latin-script languages"). Measured on real Dutch text:

| Query | Found | Ground truth in corpus |
| --- | --- | --- |
| `ontwikkelaars` | **0** | 1 doc titled "…Database Ontwikkelaar…" |
| `gemeenten` | 3 (plural-form docs only) | 4 more docs use singular `gemeente` |
| `adviseur` | 3 | includes `adviseurs` doc — via **prefix** match |
| `gemeente` | 7 | includes `gemeenten` docs — via **prefix** match |

The prefix-search-on-final-term gives a **one-way illusion** of morphology: singular→plural appears to work (only when the term is last in the query); plural→singular never does. Golden-set categories confirm: nl-morphology recall@20 **0.357**, compounds **0.429**, nl–en mix **0.333**.

**Verdict: no configuration exists to fix this — it is tokenizer-level.**

## Golden relevance set (43 queries, Recall@20)

| Category         | Mean Recall@20 |
| ---------------- | -------------- |
| exact-skill      | **1.000**      |
| phrase-filter    | 0.881          |
| semantic-synonym | 0.688          |
| compound         | 0.429          |
| nl-morphology    | 0.357          |
| nl-en-mix        | 0.333          |
| **Overall**      | **0.632**      |

18 of 43 queries had imperfect recall; every hard failure traces to the morphology/compound/tokenizer gap above. The golden lane's Manticore numbers are the comparison target when they land; on the engine budget itself, Convex at 33 docs is far inside 100ms and at 8,448 docs the broad query is an error, so the budget comparison is moot at scale.

## Undocumented ceilings found (beyond the documented 1024)

1. **The 16MiB bytes-read limit binds long before the documented 1024 search ceiling** for text-heavy documents. Even a `take(1024)` search query threw `Too many bytes read` at the 8,448-doc table for a term matching ~1.8k docs. Because queries cannot project fields, every wide `beschrijving` counts against every query that touches the doc.
2. **Exact totals share the facet death**: any "how many match" without a search term is a full scan that dies at ~3.1k of our docs.
3. **Failure-mode shift**: past bytes-read scale, the same scan fails as a 1-second query timeout instead — two different errors for one root cause.
4. **Storage/DX**: single searchField forces storing titel+beschrijving twice; 93MB local state for 33 documents.

## What worked

- Anonymous local dev is real: no account, no credentials, backend up and schema+index deployed in seconds. Best-in-class DX for the happy path.
- Exact-skill relevance is perfect on the golden set; BM25 + prefix search behave well within the 1024/16MiB envelope.
- Equality filter fields on the search index work as advertised and combine with search terms cheaply.
- Sub-millisecond query latency at fixture scale.

## Not measured (gaps)

- **Vector/hybrid search**: a vector index requires externally generated embeddings and vector search runs only in actions. This experiment's no-accounts/no-credentials constraint rules out embedding APIs, and local embedding generation would measure our embedding choice, not Convex. The schema-level facts stand from docs: ≤4096 dims, ≤256 results, actions-only.
- **Manticore relevance numbers**: owned by the golden-set lane; not reproduced here.
- **Corpus caveats**: 33 real docs is small; `contracttype` is all UNKNOWN (drafts don't carry it — it joins from the canonical row later in the real pipeline), so that facet has one bucket; `laatstGezienOp` is the ingest timestamp, not source data; scaling tables used duplicated documents, valid for cost curves only, never for relevance.

## Per-criterion verdict summary

| Criterion | Docs-only judgment | Measured verdict |
| --- | --- | --- |
| Boolean operators | fails | **Confirmed** — native: impossible; JS post-filter: works at toy scale, silently truncates at 1024, throws at ~8k docs |
| Facets (4 dims) + exact total | fails (1024 ceiling) | **Confirmed, and worse** — the real wall is 16MiB bytes-read at ~3.1k docs, ~0.04% of target corpus |
| Dutch stemming | fails | **Confirmed** — no stemming; prefix search masks it one-way only; nl-morphology recall 0.357 |

## Reproduce

```bash
# from the repo root
bun run experiments/convex-search/build-corpus.ts
cd experiments/convex-search
bun install
CONVEX_AGENT_MODE=anonymous npx convex dev   # leave running
GOLDEN_QUERIES_PATH=../../benchmarks/relevance/queries.jsonl bun run measure.ts
bun run scale.ts
```
