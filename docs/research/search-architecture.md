# Search-architectuur — instant Boolean over 2,5–15M vacatures

Datum 2026-08-27 · scope: 600k nieuwe/mnd, ~3 KB tekst per doc, NL+EN, recruiter-Boolean (AND/OR/NOT, haakjes, phrases, prefix, veld-scope), facets, deterministische result-id's, p95 ≤ 100 ms (750 ms plafond), typeahead ≤ 50 ms, één Hetzner-box.

## Architecturen

**A — Postgres SoR + Manticore RT via outbox + SearchAdapter (gekozen).** `search_outbox (id, op, version)` in dezelfde transactie; Bun-worker draint naar Manticore RT-table (MySQL/HTTP-interface); `index_version` = outbox-hoogwatermerk → snapshot `(ast_hash, index_version, ids)`. Boolean native: impliciet AND, `|`, `-`/`!`, haakjes, `"phrase"~N`, `@title`, `nation*`, `=exact` (https://manual.manticoresearch.com/Searching/Full_text_matching/Operators). Facets in één pass (https://manual.manticoresearch.com/Searching/Faceted_search). RT: RAM-chunk direct zichtbaar, flush bij `rt_mem_limit`, auto-OPTIMIZE (https://manual.manticoresearch.com/Creating_a_table/Local_tables/Real-time_table). Vendor-benchmark: 3,85× sneller dan ES 9.4.3 op 110M HN-comments; 3,98 vs 36,98 GB RAM op 10M logs; ~40 MB lege RSS; GPLv3 (https://github.com/manticoresoftware/manticoresearch). Geen infix (`min_infix_len=3` → 6,4 MB → 94,3 MB), wel `min_prefix_len=3` (https://manual.manticoresearch.com/Creating_a_table/NLP_and_tokenization/Wildcard_searching_settings). Determinisme: `ORDER BY WEIGHT() DESC, id ASC`. Failure modes: outbox-lag (versiekolom), dataverlies → rebuild uit Postgres, negation-only queries afwijzen.

**B — ParadeDB pg_search (runner-up tot ~7,5M).** `pdb.parse()` Tantivy-query-syntax (https://www.paradedb.com/blog/v2api, 2025-12-04); facets in-index, >10× sneller dan handmatig (https://www.paradedb.com/blog/faceting, 2025-12-10); Neon-benchmark 10M: filtered 34 ms, top-N 81 ms, plain count 770 ms (https://neon.com/blog/postgres-full-text-search-vs-elasticsearch, 2025-06-13); CREATE INDEX traag, één BM25-index per tabel (https://blog.rasc.ch/2026/04/paradedb.html). **Neon sloot pg_search voor nieuwe projecten op 2026-03-19** (https://neon.com/docs/extensions/pg_search) → alleen on-box. AGPL, v0.25.5 (https://pgxn.org/dist/pg_search/). Bij 15M breekt facet-zwaar 100 ms.

**C — embedded (DuckDB/LanceDB): niet voor P0.** DuckDB FTS: alleen conjunctief/disjunctief, geen phrases, index handmatig herbouwen (https://duckdb.org/docs/current/core_extensions/full_text_search); één schrijver per bestand (https://duckdb.org/docs/current/connect/concurrency). LanceDB: "doesn't support queries using boolean operators OR, AND in the search string", geen facets (https://docs.lancedb.com/search/full-text-search) — vector-sidecar 2027.

**D — eigen Rust-service op Tantivy: haalbaar, duur.** Tantivy dekt alles (grammar, phrases, facets als fast fields, 17 stemmers, MIT; https://github.com/quickwit-oss/tantivy); ~2× Lucene per maintainer-claim (https://jpountz.github.io/2025/05/12/analysis-of-Search-Benchmark-the-Game.html). Bouw: **5–7 persoonsweken** vs ~1 week integratie; escape hatch achter de adapter.

## Engine-tabel (samenvatting)

| Engine | Geneste Boolean | Phrase | Prefix | Facets | Determinisme | RAM @2,5M | Vector later | Licentie |
|---|---|---|---|---|---|---|---|---|
| Manticore | ja | ja (+proximity) | prefix | één pass | sort+id | laag | ingebouwd | GPLv3 |
| ParadeDB | ja | ja | via parser | in-index | sort+id | deelt PG | pgvector | AGPL |
| Tantivy (D) | ja | ja | ja | fast fields | sort+id+version | ≈ Manticore | eigen | MIT |
| Postgres FTS | ja | `<->` | `:*`, pg_trgm | SQL, heap-bound | sort+id | deelt PG | pgvector | core |
| OpenSearch | ja | ja | ja | aggs | 1 shard+id | 8 GB heap-vloer | k-NN | Apache |
| Vespa | ja (YQL) | ja | ja | grouping | ja | ≥4 GB | native | Apache |
| Quickwit | ja | ja | ja | aggs | immutable splits | object-storage | nee | logs-gericht |
| Meilisearch | **nee** in `q` | ja | impliciet | ja | n.v.t. | dataset ≈ RAM | ja | MIT |
| Typesense | **nee** in `q` | ja | ja | ja | n.v.t. | in-memory | ja | GPL |
| DuckDB FTS | nee | nee | nee | SQL | ja | embedded | ext | MIT |
| LanceDB | API-only | ja | ? | geen | ja | embedded | native | Apache |
| Sonic | nee | nee | typeahead | nee | — | 28 MB | nee | MPL |
| SQLite FTS5 | ja | ja | prefix | geen | ja | klein | nee | PD |
| Lakebase | = PG + `lakebase_text` BM25; geen pg_search | ja | pg_trgm | SQL | ja | 2 GB/CU | pgvector | managed |

Bronnen o.a.: https://docs.opensearch.org/latest/query-dsl/full-text/query-string/ · https://docs.vespa.ai/en/operations/self-managed/docker-containers.html · https://quickwit.io/docs/0.7.1/reference/query-language · https://github.com/meilisearch/product/discussions/626 · https://typesense.org/docs/guide/reference-implementations/boolean-search.html · https://www.sqlite.org/fts5.html · https://www.postgresql.org/docs/current/textsearch-limitations.html · https://docs.databricks.com/aws/en/oltp/projects/extensions · https://www.tigerdata.com/blog/pg-textsearch-bm25-full-text-search-postgres (pg_textsearch: 2,3× sneller dan pg_search maar géén Boolean/phrase — afgevallen).

## Sizing bij 600k/mnd (addendum)

Manticore 7,5M: raw 22 GB, index 30–40 GB, ~2–4 GB resident (attributes `mmap_preread`; https://manual.manticoresearch.com/Creating_a_table/Local_tables/Plain_and_real-time_table_settings) → 32 GB box. 15M: 45 GB raw, 60–80 GB index, 4–8 GB resident → **64 GB, aparte search-box** (page cache concurreert anders met Postgres-buffers). `rt_mem_limit` 128 MB → flush per ~40k docs; auto-optimize online (https://manual.manticoresearch.com/Securing_and_compacting_a_table/Compacting_a_table). Trigger "→ OpenSearch bij 10M" ingetrokken; nieuwe trigger: HA/multi-node of working set > 64 GB (~30M docs). ParadeDB bij 15M: facet-zwaar breekt 100 ms. OpenSearch: 2–4× RAM voor dezelfde p95.

## Redis

motian: `src/lib/upstash.ts` (`cachedQuery` TTL-cache) + stub `@upstash/ratelimit`. Gebruik alleen voor (X) per-bron token-bucket gedeeld over workers en (Y) result-cache `(ast_hash, index_version)` 60–300 s — nooit stale omdat de key met de index meebeweegt. Niet voor locks (advisory locks), dedupe (unique op `content_hash`), typeahead (Manticore prefix). ~50 MB. (https://redis.io/docs/latest/operate/oss_and_stack/management/optimization/memory-optimization/)

## Rust/Go in de pipeline (≤150 woorden)

Loont alleen ín de engine (Tantivy) en marginaal bij batch-normalisatie; beide koop je via Manticore/ParadeDB. Bun 1.3 ~77k req/s vs Go fasthttp ~68k op hello-world (https://github.com/peterbe/go-bun-compare) — zinloos zonder echte I/O. Bottlenecks zijn de sites en Postgres, niet de runtime.

Niet geverifieerd: search-benchmark-game/SeekStorm tabellen (PNG/JS), Hetzner-prijzen (later wél, zie interne kostenkaart), ParadeDB stemmer-pagina (404), LanceDB prefix-semantiek, exacte Manticore-ms op 2,5M.
