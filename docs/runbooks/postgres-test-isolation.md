# Postgres test isolation (RJC-369)

## What changed

Every Postgres-backed `bun test` run now gets its own throwaway database
instead of every DB spec sharing the long-lived `ji_test` database.

- `tools/postgres/test-isolation.ts` is loaded once per `bun test`
  invocation via `bunfig.toml`'s `[test].preload`. On startup it:
  1. Does nothing if `DATABASE_TEST_URL` is already set in the environment
     (a caller — e.g. `scripts/crabbox-exe-dev-shadow.sh` — has taken
     responsibility for pointing tests somewhere specific).
  2. Probes the admin Postgres connection (`ji_admin` by default). If it's
     completely unreachable: no-ops when `REQUIRE_DATABASE_TESTS` isn't
     `"1"` (every DB spec already skips gracefully in that case); throws
     when it is `"1"` — this never silently falls back to the shared
     database, the same guarantee RJC-395 intended for the migration-upgrade
     suite.
  3. Otherwise creates a fresh `ji_test_iso_<pid>_<random>` database,
     re-applies the same least-privilege role grants
     `tools/postgres/init/10-bootstrap-roles.sh` applies at container init
     (`CREATE DATABASE` does not copy per-database grants), runs the real
     Drizzle migrations against it as the migrator role, and points
     `DATABASE_TEST_URL` / `DATABASE_APP_TEST_URL` / `DATABASE_ADMIN_TEST_URL`
     at it.
  4. A global `afterAll` (registered outside any `describe`, which Bun
     treats as running once for the whole process, after the last test
     file) drops the isolated database with `WITH (FORCE)`. It runs under
     an explicit 60 s budget and logs `test-isolation: dropped '<db>' in
     <n> ms (<k> backend(s) still attached at drop time)`; if it ever times
     out, Bun reports that as a prefix-less `(unnamed)` hook failure under
     the last spec file, not under this module — see
     [gate-flaky-tests.md](gate-flaky-tests.md), rule 6.

Every existing spec's fallback (`process.env.DATABASE_TEST_URL ?? "<shared
ji_test URL>"`) picks up the isolated database automatically — **no spec
file needed to change**.

## Why per-process, not per-suite or per-file

`bun test` (as invoked by `tools/quality/gate.sh` and by every developer
running `bun test` directly) runs every matched file in a single process.
That is the isolation boundary this fix uses: one database per `bun test`
invocation. Two concurrent `bun test` invocations get two different process
ids and therefore two different isolated databases — the exact collision
this ticket exists to fix.

Per-suite or per-file databases were considered and rejected: running the
real migration set (12 files) costs real time, and paying that cost once
per process is far cheaper than paying it ~10+ times per run for zero
additional isolation benefit inside a single invocation. Measured on this
machine: a full `bun test --max-concurrency 2` run took 26.5s with
isolation vs 31.4s without (same shared `ji_test`, no regression — the
isolated database's smaller footprint appears to also be *faster* than
querying the always-growing shared one).

## What isolation does NOT change

- `packages/db/src/migration-upgrade.spec.ts` uses its own isolated
  `ji_migration_upgrade_test_*` database (RJC-395). RJC-425 added a shared,
  eager guard: the global preload validates an explicit
  `DATABASE_UPGRADE_TEST_URL` before any Postgres constructor, and every
  migration-upgrade suite constructs its client through the same guarded
  helper. That helper fixes its own connection options and exposes no database
  override. The validator also rejects `database`/`db` constructor override
  input and query parameters. This closes the former gap where only the first
  sibling suite's `beforeAll` checked the URL pathname.
- `scripts/crabbox-exe-dev-shadow.sh` sets `DATABASE_TEST_URL` explicitly
  before running its own suite — untouched (isolation no-ops whenever
  `DATABASE_TEST_URL` is already set).

### Migration-upgrade gate target

Leave `DATABASE_UPGRADE_TEST_URL` unset for the normal gate. The gate then
runs `tools/postgres/ensure-migration-upgrade-db.ts` and provisions its
dedicated disposable default. An explicit value is accepted only as a
`postgres://` or `postgresql://` URL whose single database pathname matches
`ji_migration_upgrade_test_<suffix>` using lowercase letters, digits, and
underscores. It must point to a disposable database reserved solely for this
suite, never a development or production database. Invalid explicit values
fail in the global test preload before its admin probe constructs a Postgres
client.

## The residue guard

`tools/postgres/residue-guard.spec.ts` is a tripwire that connects directly
to the **literal shared `ji_test` database** (ignoring `DATABASE_TEST_URL`,
which the isolation preload has already repointed elsewhere) and fails if
it finds:

- `curated.search_projection_checkpoint` rows with `index_name LIKE
  'test-index-%'` or `'drain-%'` (the two fixture-id prefixes
  `search-version-store.spec.ts` and `outbox-drain.spec.ts` used before
  isolation).
- `staging.source_record` rows belonging to a `curated.bron` row with
  `categorie = 'runtime-test'` (the test-only marker
  `bron-runtime.spec.ts` uses for its own fixtures).

**Known gap:** several specs reuse real-looking `bron.categorie` values
(`overheidsportaal`, `jobboard`, `msp_broker`) for their fixtures with no
distinguishing marker, so this guard cannot detect *every* possible fixture
shape that could leak into the shared database — only the two patterns
actually found accumulating (2,633 checkpoint rows, 1,239 source_record
rows, as of 2026-09-01) and any regression that reintroduces them. Closing
that gap fully would need a fixture-marker convention across every DB
spec, which is a separate, larger change.

**Verified as a real guard, not a guard that has never failed:** a
deliberately seeded stray `test-index-*` row made the guard fail
(`Expected: 0, Received: 1`); deleting it made the guard pass again.

**Transitional flakiness (not a bug):** while other branches in a shared
dev/CI environment still run the pre-isolation code against the same
physical `ji_test`, this guard can legitimately fail — it is correctly
detecting real, ongoing residue written by that other, unmerged code. In
this repo's development environment during this change, the shared
`search_projection_checkpoint` count was observed growing in real time from
unrelated concurrent test runs. This resolves itself once every consumer
of these specs is on the isolated path (i.e., once this change reaches
`main` and older branches are rebased); it is not an intermittent issue
this fix needs to work around, since CI runs one branch at a time.

## The one-off cleanup tool

`tools/postgres/clean-test-residue.ts` removes the residue that
accumulated in `ji_test` **before** this fix shipped. It is deliberately
separate from the isolation fix so the two can be reviewed independently.

```bash
bun tools/postgres/clean-test-residue.ts           # dry run (default) — prints counts, changes nothing
bun tools/postgres/clean-test-residue.ts --apply   # deletes
```

It deletes `search_projection_checkpoint` rows matching the two known
prefixes and `curated.bron` rows with `categorie = 'runtime-test'` (which
cascades to their `source_record` / `scrape_run` / `aanvraag_bron_link` /
`aanvraag_observation` rows via the schema's existing `ON DELETE CASCADE`
foreign keys). It does **not** touch `bron` rows with other categorie
values — see the residue guard's known gap above; a broader cleanup would
require manually confirming which rows are genuinely test fixtures rather
than guessing from category name alone.

Applied once during this change: 2,602 `search_projection_checkpoint` rows
and 1 `runtime-test` `bron` row (with 0 dependent `source_record` rows)
removed from `ji_test`.
