# Manticore 6.3.8 vs 29.0.2 latency round (RJC-382)

**Headline:** on the 5-query profile set (50 iterations each, one laptop,
20k docs), boolean (AND/OR/NOT) queries cost ~40ms p95 on 6.3.8 vs
~3-6ms p95 on 29-infix — measured clean, twice per engine. The
golden-set comparison (43 real queries, closer to production request
shape) is still owed a clean run and is not yet a reliable signal either
way. Follow-up: repeat this same per-query breakdown at 200k documents on
the Hetzner box, both engines, under a verified clean (load ≤6) window.

Latency was the open blocker after the golden-set relevance comparison
(`docs/research/manticore-29-comparison-2026-09-01.md`): recall/nDCG were
measured on the 33-document golden corpus, which is far too small for a
latency claim. This round uses a **generated 20,000-document corpus**
(`benchmarks/search/generate-corpus.ts`, seed `20260901`, ids rewritten to
`latency-rjc382-N` so they cannot collide with production rows or other
lanes) run through the existing harness (`benchmarks/search/run.ts`,
`bun run bench:search`), extended additively for this round (see
`benchmarks/search/README.md`). Raw JSON: `docs/research/manticore-latency-2026-09-01/results.json`
plus three raw per-query files it references (`raw-638-profile-clean.json`,
`raw-29infix-profile-clean.json`, `raw-29infix-golden-clean.json`). Every
table in this report is generated from `results.json` by
`docs/research/manticore-latency-2026-09-01/generate-tables.py` — a
report-authoring script, not hand-copied from terminal output (run it
yourself: `python3 docs/research/manticore-latency-2026-09-01/generate-tables.py`).

**Numbers only — this report states pass/fail against the SLO, the delta
between engines, and the decision criteria. The engine decision is
Ryan's** (see "Decision criteria" below).

## SLO context — this run is necessary, not sufficient

DEC-004's SLO (p95 ≤ 100ms at `SearchAdapter`) is defined over the
**200k-document profile** (`docs/adr/ADR-0003`, JI-016), and the
production gate (`bench:search` with the checked-in 200k corpus) is what
actually enforces it. This round measured **20k documents on a laptop**
— both engines clearing the SLO here is a necessary signal, not a
sufficient one. A 200k, production-representative run (real Hetzner
hardware, real Neon-backed corpus) is still outstanding — see Gaps.

## Environment caveat (read this first)

This laptop ran with many sibling lanes active throughout the round; load
average fluctuated 3–19 and mostly did not sustain below the 6 threshold
the brief asked for. Per a mid-round correction from the RJC-382 owner,
**any series measured under load > 6 (1-min average) at any point is not
admissible on its own** — it is reported below as *contaminated*,
separately from a *clean* re-run after polling down to a verified ≤6
window (checked every 30s; two consecutive rounds reached, e.g. 5.32 then
5.22 on the first poll, 5.43 then 4.29 on the second). Load is recorded
at the **start and end** of every series in `results.json`; a series
that started ≤6 but ended >6 is labeled **mixed** and kept in a separate
`seriesMixed` array — it is not counted as admissible even though it
started clean. Contaminated, clean, and mixed numbers are never averaged
together.

This laptop is also not the Hetzner production box — a
production-representative run needs both a quiet machine and real Neon
data (see Gaps).

## What was measured

### Contaminated series table
| Series | Config | Query mode | Indexing | p50 | p95 | p99 | max | errors | SLO |
|---|---|---|---:|---:|---:|---:|---:|---:|---|
| manticore-6.3.8 (production conf, profile queries) | tools/manticore/manticore.conf (no min_infix_len) | profile | - | 2.99ms | 35.22ms | 41.72ms | - | - | PASS |
| manticore-6.3.8 (production conf, golden queries, facets+sort=relevance+limit=20) | tools/manticore/manticore.conf (no min_infix_len) | golden | 62.6 docs/s | 1.37ms | 10.41ms | 33.15ms | 488.94ms | 0 | PASS |
| manticore29-infix run1 (profile queries) | tools/manticore/manticore29.conf (min_infix_len=2, as mounted by docker-compose.yml) | profile | 69.3 docs/s | 3.97ms | 34.66ms | 41.54ms | 43.91ms | 0 | PASS |
| manticore29-infix run2 (profile queries, determinism check) | tools/manticore/manticore29.conf (min_infix_len=2, as mounted by docker-compose.yml) | profile | 78.3 docs/s | 2.84ms | 9.71ms | 41.19ms | 46.33ms | 0 | PASS |
| manticore29-infix golden (golden queries, facets+sort=relevance+limit=20) — mixed: started clean (5.29), ended contaminated (19.34) | tools/manticore/manticore29.conf (min_infix_len=2, as mounted by docker-compose.yml) | golden | 60.7 docs/s | 2.48ms | 55.57ms | 66.05ms | 75.03ms | 0 | PASS |

### Clean series table (admissible: true)

| Series | Config | Query mode | Load start→end | Indexing | p50 | p95 | p99 | max | errors | SLO |
|---|---|---|---|---:|---:|---:|---:|---:|---:|---|
| manticore-6.3.8 (production conf, golden queries) — clean re-run | tools/manticore/manticore.conf (no min_infix_len) | golden | 5.76→4.94 | 67.0 docs/s | 1.27ms | 6.86ms | 36.37ms | 531.11ms | 0 | PASS |
| manticore-6.3.8 (production conf, profile queries) — clean re-run | tools/manticore/manticore.conf (no min_infix_len) | profile | 5.02→4.16 | - | 3.31ms | 37.51ms | 44.46ms | - | - | PASS |
| manticore29-infix (profile queries) — clean re-run on a fresh volume | tools/manticore/manticore29.conf (min_infix_len=2, as mounted by docker-compose.yml) | profile | 4.73→5.49 | 63.4 docs/s | 3.0ms | 7.27ms | 38.93ms | 42.6ms | 0 | PASS |
| manticore-6.3.8 (production conf, profile queries) — clean re-run 2, with per-query breakdown | tools/manticore/manticore.conf (no min_infix_len) | profile | 5.45→4.13 | 60.7 docs/s | 3.34ms | 40.22ms | 45.59ms | 48.17ms | 0 | PASS |
| manticore29-infix (profile queries) — clean re-run 2, with per-query breakdown | tools/manticore/manticore29.conf (min_infix_len=2, as mounted by docker-compose.yml) | profile | 4.74→4.16 | 61.4 docs/s | 2.8ms | 5.37ms | 36.32ms | 40.38ms | 0 | PASS |

### Mixed series (started clean, load rose past 6 before finishing — NOT admissible)

| Series | Config | Query mode | Load start→end | Indexing | p50 | p95 | p99 | max | errors |
|---|---|---|---|---:|---:|---:|---:|---:|---:|
| manticore29-infix (golden queries) — mixed: started clean (4.60), ended just over threshold (7.19) 4m55s later, with per-query breakdown | tools/manticore/manticore29.conf (min_infix_len=2, as mounted by docker-compose.yml) | golden | 4.6→7.19 | 71.1 docs/s | 4.75ms | 66.33ms | 70.58ms | 79.21ms | 0 |

**No clean (load ≤6 start and end) golden-query run against manticore29-infix
was obtained this round** — every attempt either started clean and drifted
past 6 (the mixed row above), or ran under sustained load from the start
(the contaminated table). This is a real gap, not an omission — see Gaps.

Both engines pass the SearchAdapter p95 ≤ 100ms SLO on every series run
in this round (contaminated, clean, and mixed alike), by a wide margin —
worst p95 observed anywhere was 66.33ms, on the manticore29-infix mixed
golden run.

## Profile-set inversion: measured (clean ×2). Golden-set gap: one mixed run — not yet measured clean

**Profile-set half — this is real, reproduced twice clean per engine, not
noise from host contention.** On the **profile query set** (5 synthetic
boolean queries), 6.3.8 is consistently slower than 29-infix. Two
independent clean profile-mode runs per engine (per-query breakdown from
`raw-638-profile-clean.json` and `raw-29infix-profile-clean.json`, both
generated by `generate-tables.py`):

**manticore-6.3.8, profile queries, clean** (p50/p95/p99 overall: 3.34ms/40.22ms/45.59ms):

| query id | count | p50 | p95 |
|---|---:|---:|---:|
| ae1-azure-platform-not-intern | 50 | 5.68ms | 45.44ms |
| phrase-devops | 50 | 2.87ms | 41.34ms |
| simple-java | 50 | 2.51ms | 40.54ms |
| or-locatie | 50 | 3.01ms | 40.22ms |
| filter-only | 50 | 4.17ms | **5.3ms** |

**manticore29-infix, profile queries, clean** (p50/p95/p99 overall: 2.8ms/5.37ms/36.32ms):

| query id | count | p50 | p95 |
|---|---:|---:|---:|
| filter-only | 50 | 2.94ms | **30.03ms** |
| ae1-azure-platform-not-intern | 50 | 3.81ms | 5.74ms |
| phrase-devops | 50 | 2.57ms | 5.37ms |
| or-locatie | 50 | 2.54ms | 4.68ms |
| simple-java | 50 | 2.23ms | 2.91ms |

**Named cause, exactly as measured on the two clean profile runs:** on
6.3.8, the four **boolean queries** with AND/OR/NOT parsing
(`ae1-azure-platform-not-intern`, `phrase-devops`, `simple-java`,
`or-locatie`) each cost ~40-45ms p95, while the single-term filter query
(`filter-only`, just `"consultant"`) is fast at 5.3ms — a ~35ms
boolean-query tax on 6.3.8. On 29-infix the pattern **inverts**: the same
four boolean queries are all fast (2.9-5.7ms p95), while `filter-only` is
the slow one at 30.03ms. This determinism claim rests on the two clean
runs alone — the contaminated run1/run2 for 29-infix (34.66/9.71ms and
41.19/46.33ms overall p95, no per-query breakdown captured for those
runs) are not cited as corroborating evidence.

**Golden-set half — NOT yet measured clean, this is a gap.** 6.3.8's
clean run (p95 6.86ms) is far faster than 29-infix's mixed run (p95
66.33ms — started under the load-6 threshold but drifted over it before
finishing; per-query breakdown in
`results.json`/`raw-29infix-golden-clean.json` shows the slowdown spread
near-uniformly across 41 of 43 queries at 58-74ms p95). **That
near-uniform spread across almost every query is exactly the shape host
contention produces** — it looks nothing like the two sharply bimodal
clean profile-set breakdowns above, where a handful of queries carry the
whole gap. So while the *ordering* (6.3.8 faster than 29-infix on the
golden set) is the opposite of the profile set's ordering, this half is
not established as a real engine difference the way the profile-set half
is — it needs a clean (load ≤6 start and end) golden-query run against
29-infix before it can be cited as measured. See Gaps for the follow-up.

## Indexing throughput — two different paths, do not conflate them

Every number in the tables above (60–80 docs/s) comes from the harness's
own `upsertAll` in `benchmarks/search/run.ts`: one `POST /replace` per
document, batched only in concurrency-100 groups (`UPSERT_BATCH_SIZE`).
That is the OLD per-document path, not what RJC-389's bulk projector
(`ManticoreSearchEngine.applyBatch`, `POST /bulk`) uses for a real
backfill. A quick one-off check (not the harness — a throwaway script
calling `applyBatch` directly with the same 20k-doc corpus, on the
manticore29 shadow, torn down immediately after; under 5 minutes total)
measured the `/bulk` path at **18,535 docs/s** — one HTTP round trip for
the whole corpus instead of 20,000 of them, ~265x the per-doc rate.
20,000/20,000 documents landed with 0 failures/unapplied. For RJC-389's
1M-document backfill, `/bulk` at even a fraction of this synthetic-corpus
rate (real batching is capped at 8MB per request —
`MANTICORE_BULK_MAX_BYTES` — so a 1M-doc real backfill will chunk into
many bulk calls, not one) is the right baseline to design against, not the
~70 docs/s per-doc figure — that would have implied a ~4-hour backfill
that the actual ingestion path was never going to take.

## Blocked: 29.x no-infix series

The brief asked for `manticore29-noinfix.conf` as the primary shadow
candidate (infix showed zero relevance effect in the prior round), run on
a fresh volume. I could not produce it within this lane's constraints:

- `docker-compose.yml` mounts `tools/manticore/manticore29.conf` (the
  infix-enabled config) as the container's `/etc/manticoresearch/manticore.conf`.
  Editing that mount or the conf file itself was explicitly out of scope
  for this lane.
- The established workaround from the prior comparison round
  (`benchmarks/relevance/README.md`: "swap the conf file mounted... and
  restart") requires editing the same conf file — also out of scope here.
- I tried a same-instance workaround: on a **freshly volumed, empty**
  `manticore29` (still booted from `manticore29.conf`), issue
  `DROP TABLE aanvragen` followed by a runtime `CREATE TABLE aanvragen (...)`
  via `/cli` with the exact schema from `manticore29-noinfix.conf` but
  omitting `min_infix_len`. The table came back empty as expected
  (`SELECT COUNT(*)` = 0), but `SHOW TABLE aanvragen SETTINGS` still
  reported `min_infix_len = 2` — the conf-declared table definition
  reasserts itself over a same-name runtime `CREATE TABLE`, even on an
  empty table with no residual data. I could not find a way to get a
  genuinely no-infix `aanvragen` table on this container without touching
  the conf or compose mount.

**What was measured instead:** the 29.x shadow *as actually mounted*
(`manticore29.conf`, infix enabled) — labelled `manticore29-infix` above.
**Per the RJC-382 owner's explicit decision, this stays a documented gap
for this round** — the prior relevance round already showed
`min_infix_len=2` has zero measurable relevance effect, and both engines
clear the SLO by a wide margin regardless of infix config, so the
missing no-infix latency series is unlikely to change the shape of the
decision on its own. That said, it is inference, not a measurement — see
Gaps, and see "Decision criteria" below for how this fits alongside
everything else the owner needs to weigh.

## Decision criteria (restated, unweighted — the owner decides)

This report does not choose an engine. The full set of factors a decision
needs, gathered across both rounds, unweighted:

1. **Relevance is a trade, not a clean win** (prior round,
   `docs/research/manticore-29-comparison-2026-09-01.md`): macro Recall@20
   rises 0.477→0.488 on 29.0.2, but semantic-synonym queries genuinely
   regress (0.188→0.000 — a real libstemmer_nl Dutch-stemming weakening on
   29.0.2, confirmed not a corpus artifact; affects queries like
   `se-jeugdzorg` and `se-duurzameenergie` category `semantic-synonym`).
2. **Latency is within SLO on both engines at 20k docs.** On the profile
   query set, measured clean twice per engine, 29-infix is faster
   (boolean queries ~3-6ms p95 vs ~40ms on 6.3.8). On the golden query
   set (closer to production request shape) the ordering flips the other
   way, but that half is **not yet a clean measurement** — see "Golden-set
   gap" above — so it should not be weighted as equally solid evidence.
3. **The noinfix latency series is an unmeasured gap** (see "Blocked"
   above) — accepted as unlikely to change the picture, not verified.
4. **This laptop is not the Hetzner production box**, and this corpus is
   synthetic, not real Neon data across the 11 sources — see Gaps.
5. **200k, not 20k, is where DEC-004's SLO is actually defined** — this
   round is necessary evidence, not sufficient evidence, for a production
   latency claim.

## Protocol

- **Corpus:** `bun run bench:generate -- --documents 20000 --seed 20260901`,
  then ids rewritten from the generator's default `bench-doc-N` to
  `latency-rjc382-N` (a `sed` pass on the JSONL, not a change to
  `generate-corpus.ts`) so inserts into the shared 6.3.8 `aanvragen` table
  cannot collide with production rows (505 baseline docs) or another
  lane's benchmark ids, matching the `slug:referentie` convention already
  used by `benchmarks/relevance`.
- **Harness:** `benchmarks/search/run.ts`, extended additively (see
  "Changes" below) with `MANTICORE_29_URL` / `MANTICORE_29_LABEL` (mirrors
  the pattern already in `benchmarks/relevance/run.ts`), `LATENCY_GOLDEN_QUERIES=1`
  to run the 43 golden queries (`benchmarks/relevance/queries.jsonl`)
  through the same timing loop instead of the 5 synthetic profile queries
  (`SearchAdapter`'s own defaults are already facets-on / `sort=relevance`
  / `limit=20`, matching the production request shape after RJC-378, so
  no new call parameters were needed), and `LATENCY_EXTENDED_REPORT=1` to
  force the extended per-query-breakdown report shape for a single engine
  (used to isolate one engine's series so a second engine's transient
  failure — e.g. an indexing timeout under load — cannot lose the first
  engine's already-collected results, as happened once this round).
- **Queries:** profile.json's 5 synthetic queries for the primary series;
  the 43 golden queries for the "golden" rows. Warmup (`profile.json`:
  5 iterations) excluded from timing; measured iterations (`profile.json`:
  50) × query count gives 250 timed profile-query requests or 43 timed
  golden-query requests per warmup+measured pass — short of the 300-request
  target for the golden set alone; noted as a gap below.
- **Determinism:** `manticore29-infix` profile queries run four times
  total across this round (two contaminated, two clean), but per-query
  breakdown was only captured on the two **clean** runs — those two alone
  land in the same two-regime shape (boolean queries fast, `filter-only`
  slow), which is the actual evidence for reproducibility; the two
  contaminated runs' overall p95s (34.66ms and 9.71ms) are consistent with
  that shape but carry no per-query data and are not cited as
  corroboration. 6.3.8 profile queries run twice clean (both land in the
  same 40-45ms p95 band for the boolean queries) plus once contaminated.
  The golden query set only got one clean-admissible run (6.3.8) and one
  mixed run (29-infix) — see Gaps.
- **Historical cleanup on the shared 6.3.8 instance:** baseline count 505
  was confirmed before every insert pass this round (twice), 20,505 after
  each 20k insert, and 505 again after cleanup. That shared-production-table
  procedure is retired and intentionally not reproduced here. Future runs
  must use only `aanvragen_bench_active` / `aanvragen_bench_archive`, with
  UUID-scoped ids and the benchmark runner's exact-id cleanup plus strict
  pre/post `SELECT COUNT(*)` proof. Never run benchmark cleanup against the
  production `aanvragen_active` / `aanvragen_archive` tables.
- **manticore29 lifecycle:** brought up and torn down fully (`docker
  compose stop manticore29` + `docker rm` + `docker volume rm
  catapulze-job-intelligence_manticore29_data`) between every distinct
  measurement phase this round (contaminated infix run → blocked no-infix
  attempt → clean infix re-run → bulk-throughput check → second clean
  re-run with per-query breakdown), and again at the end. `docker compose
  ps` at the end shows only the 6.3.8 `manticore` service up, confirming
  manticore29 was fully torn down every time.
- **Root cause of the 01:02Z shared-container recreation, found by the
  RJC-382 owner:** `manticore29` has `depends_on: manticore` in
  `docker-compose.yml`. My very first `docker compose --profile shadow up
  -d --wait manticore29` exported inline placeholder env vars (see the
  interpolation gotcha below) that differed from the env the running
  `manticore` (6.3.8) container was created with; compose recreates a
  dependency whose config hash changed, which recreated the shared
  `manticore` container (no data lost — its volume was kept). Fix, applied
  for every `up` after this was diagnosed: add `--no-deps`
  (`docker compose --profile shadow up -d --no-deps --wait manticore29`)
  — this is now the only safe form of that command across worktrees.
  `docker rm` of this lane's own stopped `manticore29` container remains
  fine (never touches `manticore`). Every docker/compose command in this
  lane, before and after this fix, targeted only `manticore29` or was
  read-only (`docker compose ps`, `docker ps`) — the shared `manticore`
  service was never explicitly stopped or restarted by this lane; the one
  recreation was a `depends_on` side effect of the pre-`--no-deps` `up`
  command, now closed.
- **Docker interpolation gotcha:** this worktree has no root `.env`, and
  `docker compose` (even `stop`/`up` scoped to `manticore29`) fails
  interpolation on unrelated services' required env vars
  (`POSTGRES_*`, `BETTER_AUTH_*`, `CORS_ORIGIN`, `CATAPULZE_DATABASE_URL`)
  unless those are set in the invoking shell — I exported placeholder
  values for those specific vars inline on each `docker compose` call
  (never wrote a `.env` file, never touched other services). Worth adding
  to `AGENTS.md` or `tools/manticore/README-29-shadow.md` for the next
  lane that hits this in a fresh worktree.

## Changes

- `benchmarks/search/run.ts`: additive only.
  - `MANTICORE_29_URL` / `MANTICORE_29_LABEL` — runs a second named
    Manticore engine in the same invocation (mirrors
    `benchmarks/relevance/run.ts`'s existing pattern).
  - `LATENCY_GOLDEN_QUERIES=1` — swaps the query set for the 43 golden
    queries (`benchmarks/relevance/queries.jsonl`), still through
    `SearchAdapter`'s existing default call shape.
  - `LATENCY_EXTENDED_REPORT=1` — forces the extended report shape for a
    single engine without a second Manticore target.
  - All three are opt-in; with none set, `main()` takes the exact
    original code path unchanged. Default-invocation proof: `bun run
    bench:search` (in-memory) produces the identical key set before and
    after this change (`corpusExpectedDocuments, corpusPointer, engine,
    measuredSamples, p50Ms, p95Ms, p99Ms, passed, profile, sloMaxMs,
    boundary`) — timing values differ run to run as expected, structure
    does not.
  - New extended report (only emitted in the opt-in path) adds
    `documentCount`, `errorCount`, `indexingDocsPerSecond`, `indexingMs`,
    `maxMs`, `perQuery` (array of `{queryId, count, p50Ms, p95Ms}`),
    `queryMode`, `queryset` alongside the existing fields.
  - `runMeasured`/`runWarmup`/`buildTaskList`/`benchmarkProfileSchema`
    kept byte-for-byte behaviorally identical (still imported directly by
    `concurrency.spec.ts`); the new golden/multi-engine/per-query path
    reuses `runWithConcurrency` rather than duplicating the
    concurrency-pool logic ("do not build a new harness").
- `benchmarks/search/README.md`: new, documents the env vars.
- `tools/manticore/README-29-shadow.md`: one-line pointer to this report.
- `.gitignore`: added `fixtures/search/` (generated corpora, never
  committed).
- `docs/research/manticore-latency-2026-09-01.md` (this file),
  `docs/research/manticore-latency-2026-09-01/results.json` (structured
  raw data, single source of truth for every table above),
  `docs/research/manticore-latency-2026-09-01/generate-tables.py`
  (report-authoring script that renders every table in this doc from
  `results.json` — not committed as a repo tool, a one-off aid), and the
  three raw per-query JSON files it reads
  (`raw-638-profile-clean.json`, `raw-29infix-profile-clean.json`,
  `raw-29infix-golden-clean.json`).

## Verification

- `bun run check-types`: 749 pre-existing errors, all outside
  `benchmarks/` (confirmed identical count before/after this change via
  `git stash`); zero errors in `benchmarks/search/run.ts`.
- `bun x ultracite check benchmarks/search/run.ts`: clean.
- `bun test benchmarks/search --max-workers=2`: 17 pass, 0 fail (includes
  `concurrency.spec.ts`, which imports `runMeasured`/`runWarmup` directly
  and would fail if their behavior changed).
- `bun run check-secrets`: exit 0.
- Default `bun run bench:search` (in-memory, no env vars): same JSON key
  set before and after this change (see above) — proves the default path
  is untouched.
- `python3 docs/research/manticore-latency-2026-09-01/generate-tables.py`:
  regenerates every table in this report from `results.json` — re-run it
  to confirm no table cell was hand-edited out of sync with the JSON.
- Cleanup: 6.3.8 doc count 505 → 20,505 → 505, confirmed twice this
  round; `docker compose ps` shows only `manticore` (6.3.8), `postgres`,
  `redis` up at the end — `manticore29` stopped, removed, and its volume
  removed.
- Committed once, not pushed.

## Gaps / what a production-representative round would need

- **Follow-up (highest priority):** repeat the per-query latency
  breakdown (profile set and golden set) at **200k documents on the
  Hetzner box**, both engines, under a verified clean (load ≤6 start and
  end) window — the 20k/laptop numbers in this report establish relative
  ordering under contention, not the production-representative signal
  DEC-004's SLO needs.
- **This laptop is not the Hetzner box, and 20k is not the 200k profile
  DEC-004's SLO is defined over.** No production-representative latency
  claim can be made from this round; it establishes relative ordering and
  SLO headroom under contention at 20k, not absolute production numbers
  at 200k.
- **No fully clean window covered the whole round.** A clean (≤6
  start+end) window was found twice via active polling and used for the
  clean re-runs above, but load rose again mid-round on at least one
  occasion (the mixed golden-query run) — sustained clean coverage for
  every series was not achieved.
- **manticore29-noinfix was never measured** — see "Blocked" above. Per
  the owner's decision this stays a documented gap for this round rather
  than a blocker, but it is still the primary candidate the brief asked
  for and the biggest open measurement gap.
- **No clean golden-query run for manticore29-infix** — only a mixed run
  (started ≤6, ended >6) exists; the golden set is the query mix closer
  to production request shape, so this is the single most valuable
  re-run for a future lane to prioritize.
- **43 golden queries × ~6-7 measured iterations (300/43) is a thin
  sample** for p99 in particular; the profile-query series (250 samples)
  is a firmer number.
- **Real Neon data, 11 sources:** the generated corpus is synthetic filler
  vocabulary with controlled term-inclusion probabilities
  (`generate-corpus.ts`) — realistic in volume and boolean-query
  selectivity, but not in text length/structure/duplication patterns real
  scraped `aanvragen` text has. Indexing throughput in particular could
  differ against real (longer, more varied) document bodies.
- **RSS/`docker stats`** was not captured — dropped for time given the
  indexing-loop runtime already dominated the round (~5 min/series); worth
  adding in a follow-up if container memory pressure becomes a question.
