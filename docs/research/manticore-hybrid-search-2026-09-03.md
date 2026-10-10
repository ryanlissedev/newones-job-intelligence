# Hybrid search on Manticore: what 6.3.8 and 29.0.2 actually do (2026-09-03)

Written because two places in this repo state that Manticore 29.x gives us
"native hybrid search (BM25 + KNN with **RRF fusion**)" — `docker-compose.yml`
(the `manticore29` service comment) and `tools/manticore/README-29-shadow.md`.
That claim is part of RJC-382's value case. It was probed directly, and the
fusion half of it does not hold on the pinned `29.0.2` tag.

Everything below is probe output from throwaway containers on the exact
pinned images, not documentation reading.

## 1. 6.3.8 (the served production pin) cannot do vector search at all

```
docker run --rm manticoresearch/manticore:6.3.8
CREATE TABLE knn_probe (id bigint, title text,
  embedding float_vector knn_type='hnsw' knn_dims='4' hnsw_similarity='cosine');

ERROR 1064 (42000): error adding table 'knn_probe': knn library not loaded
```

The KNN library is not in the 6.3.8 image. There is no `float_vector` column,
so there is no vector retrieval path to build on. **Hybrid search is blocked on
RJC-382 in the strongest sense** — not "would be nicer on 29", but "impossible
on 6.3.8".

## 2. 29.0.2 has both the KNN and the embeddings libraries

```
29.0.2 2f9c226b6@26081409 (columnar 13.9.0) (secondary 13.9.0)
       (knn 13.9.0) (embeddings 1.1.1)
```

`float_vector` columns create, index and query correctly:

```sql
SELECT id, title, knn_dist() FROM knn_probe WHERE knn(embedding, 2, (0.1,0.2,0.3,0.4));
-- 1  azure platform engineer  0.000000
-- 2  java developer           0.15729898
```

The `embeddings 1.1.1` library matters for planning: Manticore 29 can generate
embeddings itself from a text field, so hybrid search does **not** necessarily
require standing up a separate embedding service or paying an embedding API.
The model choice is still open and still matters (see §5).

## 3. The RRF-fusion claim does not hold on 29.0.2

SQL, exactly as the READMEs describe it:

```sql
SELECT id, title FROM p WHERE MATCH('azure') AND knn(embedding, 2, (...))
  OPTION fusion='rrf';

ERROR 1064 (42000): unknown option 'fusion'
```

The HTTP `/search` API — which is what `packages/search` actually speaks — does
accept `query` and `knn` in one request, but it **intersects** them rather than
fusing them. Three probes on a two-document table:

| request | hits |
|---|---|
| `knn` alone (k=2) | 2 — both documents |
| `query_string: "developer"` alone | 1 — doc 2 |
| `query_string: "developer"` **+** `knn` (k=2) | 1 — doc 2 |

If it were RRF fusion, the third row would return both documents, ranked by
fused rank. It returns the intersection: KNN supplies candidates, the lexical
query filters within them. **A document that only the vector path can find never
surfaces.**

That is precisely the case hybrid search is wanted for. Our golden set
(`benchmarks/relevance/queries.jsonl`) is 43 queries across six categories:

| category | queries |
|---|---|
| exact-skill | 8 |
| semantic-synonym | 8 |
| nl-morphology | 7 |
| compound | 7 |
| phrase-filter | 7 |
| nl-en-mix | 6 |

`semantic-synonym` is 8 of 43 and scores **0.188–0.202** against **0.523–0.529**
overall (per the RJC-382 comparison round). Those are queries where the right
document does not contain the query's words — exactly what an intersection
cannot rescue, because the lexical clause eliminates the document before
ranking ever happens.

So: upgrading to 29.0.2 and adding a `float_vector` column would **not**, on its
own, move the semantic-synonym number. This is the part of the plan that needed
correcting before anyone builds it.

## 4. What would actually work

Two options, both real, neither free:

1. **Client-side fusion.** Issue the BM25 search and a KNN search as two
   requests and fuse the rankings in `packages/search` (RRF is ~15 lines).
   Works on any Manticore with KNN, gives us the fusion constant and the
   per-path weights as tunable values, and is measurable against the golden set
   before anything ships. Costs a second round trip per query — which the
   engine already parallelises for the archive count, so the shape exists.
2. **A newer Manticore.** `dev-29.3.x` tags exist; the README already notes they
   are development builds, not release candidates. If a stable line ships native
   fusion, option 1 becomes a stopgap. Do not plan around an unreleased tag.

Option 1 is the one worth prototyping, because it is measurable now and its
result is what tells us whether vectors help these 8 queries at all.

## 5. Decisions this still needs from Ryan

1. **RJC-382 itself.** No vectors without it. The handoff's own summary stands:
   exact relevance parity under `libstemmer_dutch_porter`, latency unmeasured,
   supported version. Nothing here changes that trade — it only removes "native
   RRF fusion" from the benefit column.
2. **Embedding model.** Dutch-language quality is the whole point, and the
   obvious defaults are English-centric. `multilingual-e5` and `bge-m3` are the
   realistic candidates; `all-MiniLM-L6-v2` is not, for this corpus. Model
   choice drives `knn_dims`, index size and indexing time at the 7.5M-document
   target.
3. **Reindex budget.** A `float_vector` column bumps `SEARCH_SCHEMA_HASH`, and
   the v4 hash refuses old checkpoints — so this is a full reindex plus an
   embedding pass over the whole corpus, not a rolling change.

## 6. What was NOT done here

- No embedding model was downloaded or benchmarked. `embeddings 1.1.1` is
  present in the image; that it loads a given model on this hardware is
  unverified.
- No relevance measurement. Whether vector retrieval actually fixes those 8
  queries on our corpus is unknown and is the first thing a prototype should
  measure, before any schema decision.
- Nothing was changed in `packages/search`, the compose file, or the Manticore
  configs. This document is a correction to a written claim, not a code change.

The stale claims should be corrected in place when RJC-382 is next picked up.
Verified against `main` @ `4a0ac6a`: `docker-compose.yml:117` and
`tools/manticore/README-29-shadow.md` lines 3, 21 and 24 all describe 29.x as
having "RRF fusion".

## 7. Status of the migration itself (re-checked 2026-09-04)

We have **not** migrated. On `main` @ `4a0ac6a` the served `manticore` service
is still `6.3.8` (`docker-compose.yml:87`); `29.0.2` is still gated behind the
`shadow` profile (`:126`). Three RJC-382 PRs merged — #90 (shadow instance),
#98 (golden-set comparison), #102 (latency round) — all evaluation, none
switching production. The migration is a single unmerged commit, `68e8602` on
`feat/manticore-29-production` (15 files: the compose pin, the `dutch_porter`
morphology fix in `manticore.conf`, deletion of the shadow configs and probe,
and a `version.ts` bump), with no PR open for it.
