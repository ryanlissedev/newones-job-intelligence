# CTP-634 measurement commands

Testhost: development MacBook — Apple M5 Pro, 18 cores, 64 GiB, macOS arm64
Worktree: `/private/tmp/w13-k5-loadproof`
Branch: `ryan1/ctp-634-w5k5-beslis-met-een-loadproef-of-een-tweede-worker`
Base: `5f7d05da77264291d2e41efba8e9377c8968fdce`
Postgres: `catapulze-job-intelligence-postgres-1` (PostgreSQL 16.14) on
`127.0.0.1:5432` — disposable `ji_k5_l{2,4,6,8}_*` databases only.

```bash
bun install --frozen-lockfile

# Focused specs for the measurement logic (11 tests)
bun test benchmarks/worker-slots/probe.spec.ts

# Typecheck the benchmark lane
bun run check-types:benchmarks

# Lint/format the new files
PATH="./node_modules/.bin:$PATH" ultracite fix benchmarks/worker-slots/

# Final evidence run: 13 bronnen x 40 minted items = 520-item corpus,
# levels 1/2/4/6/8 (1 = production-shaped single-consumer baseline),
# ~2.2 min of measured wall time + provisioning overhead
K5_LEVELS="1,2,4,6,8" K5_ITEMS_PER_BRON=40 K5_OUTPUT_DIR=docs/evidence/ctp-634 \
  bun run bench:worker-slots
```

Optional knobs (defaults shown):

```bash
K5_LEVELS="2,4,6,8" \
K5_ITEMS_PER_BRON=40 \
K5_CRAWL_DELAY_MS=5 \
K5_RATE_LIMIT_PER_MINUTE=600 \
K5_LEVEL_DEADLINE_MS=600000 \
K5_OUTPUT_DIR=.artifacts/performance/worker-slots \
bun run bench:worker-slots
```

Postgres credentials default to the `tools/postgres/test-isolation.ts`
locals (`ji_admin` / `ji_migrator` / `ji_app`); override via
`POSTGRES_ADMIN_*`, `POSTGRES_MIGRATOR_*`, `POSTGRES_APP_*`,
`POSTGRES_HOST`, `POSTGRES_HOST_PORT` if the box differs.

Safety posture of the run: no live-source flags set, fixture connectors
only, `SEARCH_PROJECTOR=onbox`, `RAW_S3_*` scrubbed per level so the raw
store is always the disposable filesystem dir, every database the script
touches matches `ji_k5_*` and is dropped afterwards (including on
provisioning failure), no shared/dev database is queried or mutated. No
lease, no order, no provisioning.
