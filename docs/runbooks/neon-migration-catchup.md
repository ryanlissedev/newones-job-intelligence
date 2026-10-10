# Neon migration catch-up (RJC-402)

## Current status: BLOCKED pending release-specific evidence and approval

## Historisch record: UITGEVOERD — 2026-09-01 (catch-up 0006–0013)

Deze catch-up is **uitgevoerd tegen productie-Neon** (project `catapulze-ji`,
branch `production`) op 2026-09-01. Niet nog een keer draaien; `db:migrate` is
idempotent, maar de rollback-branch hieronder hoort bij deze ene uitvoering.

- **Rollback-branch (vóór de migratie):** `br-withered-shadow-zatb46q2`
  (`pre-migration-0006-0011-20260901-1122`). Laat staan tot de deploy bewezen
  stabiel is; daarna opruimen.
- **Resultaat:** journal 6 → 13 (13 want migratie 0012 `listing_hash` landde
  dezelfde dag op main, ná het schrijven van dit runbook).
- **Data ongewijzigd, geverifieerd na afloop:** `curated.aanvraag` 4,
  `staging.source_record` 145, `curated.outbox_event` 3, `curated.scrape_run` 8.
- **Nieuwe objecten aanwezig:** `curated.search_projection_checkpoint`,
  `curated.search_projection_state`.
- **`sequence_number` backfill:** 1, 2, 3 — op volgorde, geen gaten, geen NULLs.
- **`curated.outbox_event.index_version`:** nu `bigint` (de int→bigint-rewrite
  die als enige echte risico was aangemerkt).

De baseline die vooraf is gemeten kwam exact overeen met de kwantificering in
dit document (6 migraties, 4/145/3/8 rijen, beide nieuwe tabellen afwezig).

## Verdict: GO

> **Execution stop.** The reviewed integration base
> `80e2882447e1a678855c1334aa30a752808d0f7c` contains exactly 15 ordered
> migrations (`0000`–`0014`), ending in
> `0013_durable_user_writes` followed by `0014_auth_user_role`. The 2026-09-01
> rehearsal in this document covered only `0006`–`0011` and expected a 12-row
> journal. It does not rehearse or prove `0012`, `0013`, or `0014`, and it is
> not current Neon evidence. A local, unpublished operator record dated
> 2026-09-01 claimed that the live journal moved from 6 to 13 entries. No
> current live readback confirms even that state, and it says nothing about
> `0013` or `0014`.
>
> `bun run db:migrate` applies every pending migration in the checked-out
> commit. Do not run it until the immutable deployment SHA, exact live journal,
> affected schema objects, current-snapshot rehearsal, writer-free final
> preflight, validated rollback branch, and definitive operator GO all agree on
> the same pending set.

Required execution order:

1. Pin the full 40-character `DEPLOY_SHA` from the candidate Coolify release or
   release manifest. Never derive this gate from a moving `main` ref.
2. Derive the complete ordered expected journal from that commit's
   `packages/db/src/migrations/meta/_journal.json` and SQL blobs. Read the
   complete live `drizzle.__drizzle_migrations` journal ordered by
   `created_at, id`, then prove the live sequence is an exact prefix. A count
   or latest timestamp alone is insufficient.
3. Read every affected schema object, including the `0012` column and the
   `0013`/`0014` objects in the verification matrix below. The smallest
   `0012` readback is:

   ```sql
   SELECT column_name, data_type, is_nullable
   FROM information_schema.columns
   WHERE table_schema = 'staging'
     AND table_name = 'source_record'
     AND column_name = 'listing_hash';
   ```

   For the reviewed integration base, fully applied means this row plus the
   `0013` scope/markering objects, the `0014` role contract, and all 15 matching
   journal entries. These are expectations derived from committed code,
   **not** a claim that production has applied them.
4. Record the exact pending tags and rehearse that exact set against a fresh
   branch of the current production snapshot. A successful rehearsal is not
   the definitive execution GO.
5. Freeze every writer, repeat the final production preflight, and create and
   validate a fresh rollback branch while that freeze remains in force.
6. Only then obtain the definitive GO tied to `DEPLOY_SHA`, pending tags,
   rehearsal verdict, rollback branch ID/parent/creation time, and successful
   rollback-branch query evidence. With no intervening state change, run the
   migration immediately.

## Historical rehearsal verdict: GO for `0006`–`0011` only

**The fact that decided the historical verdict:** every `0006`–`0011`
statement ran against a table with at most 145 rows in the captured
2026-09-01 Neon snapshot, and the slowest single statement
measured in this rehearsal — the `index_version integer→bigint` rewrite on
`curated.outbox_event` — took **20ms**. There is no meaningful lock-contention
window at that historical data volume. This finding says nothing about
`0012`–`0014` or current live row counts and is not current execution
approval.

Historical status: `0006`–`0011` were quantified and rehearsed against a real
clone of the Neon state captured and re-read on 2026-09-01. They were not run
against Neon in the documented session. All documented writes happened
against a disposable local Postgres cluster. No equivalent rehearsal or live
verification for `0012`–`0014` is recorded here.

## The problem

Historical finding while gathering restore-drill evidence for
[neon-restore.md](neon-restore.md): Neon's applied migration journal
(`drizzle.__drizzle_migrations`) stopped at migration `0005`; the commit under
test shipped through `0011`. That 2026-09-01 readback is retained below as
evidence for the old rehearsal, not as the current Neon state.

```
$ psql "$NEON_DATABASE_URL" -Atqc "select id, hash, created_at from drizzle.__drizzle_migrations order by created_at;"
1|334fc050ca88b709a68a549b3136a75fd33c93c894626d88333ab19905a5fb4c|1787901031567
2|09059d09f965add669ebbcc934da26858901588f470f27c8cdc44160ce06b000|1787990667949
3|72e2b0c19d2a21c57369f484db335d3a3fa0d56efb10eb4f425054537def9a4a|1788076800000
4|75e9bca8d4986e34e96a737eedf87a50ed8383309cdd096eb61c31bac3bccaf1|1788163200000
5|be8446d360a40d1dc0acbd4ab237ff9561f25637dc3299fb134cb6459fe0fd24|1788249600000
6|156a49f5db9ad6dfcc7782f51c959689541ec7fd60bb44b30bb84c5e0b851244|1788336000000
```

Six rows meant migrations `0000`–`0005` were applied in that historical
readback. The reviewed integration base now has `0000`–`0014` (15
migrations); its live Neon state has not been established in this document.

## Historical object checks for `0006`–`0011`

Read-only queries against Neon (`information_schema.columns`, `to_regclass`,
`count(*)`) — first pass 2026-09-01, re-verified read-only the same day:
row counts and journal depth (6 applied) unchanged between passes.

| Migration | Object | In the 2026-09-01 Neon readback | Additive or rewriting | Rows affected |
|---|---|---|---|---:|
| `0006` | `curated.outbox_event.sequence_number` (bigint, identity) | **Missing** | Rewriting — backfill via `UPDATE` + `SET NOT NULL` + `ADD GENERATED` | 3 |
| `0006` | `curated.search_projection_checkpoint` (table) | **Missing** | Additive — new table | 0 |
| `0006` | `outbox_event_sequence_number_uidx` (unique index) | **Missing** | Additive — `CREATE UNIQUE INDEX` (not `CONCURRENTLY`) | 3 |
| `0007` | `curated.query_snapshot.index_version` → bigint | Present as `integer` | Rewriting — `ALTER COLUMN TYPE` | 0 |
| `0007` | `curated.query_snapshot.search_generation`, `.search_applied_sequence` | **Missing** | Additive column + `UPDATE` backfill + `SET NOT NULL` | 0 |
| `0008` | `curated.outbox_event.index_version` → bigint | Present as `integer` | Rewriting — `ALTER COLUMN TYPE` | 3 |
| `0008` | `curated.outbox_event.claimed_until/.retry_count/.last_error/.dead_lettered_at/.claim_token` | **Missing** | Additive (nullable, or `DEFAULT 0 NOT NULL` — PG11+ fast-default, no rewrite) | 3 |
| `0008` | `curated.search_projection_state` (table) | **Missing** | Additive — new table | 0 |
| `0008` | 2 partial indexes on `outbox_event` | **Missing** | Additive — `CREATE INDEX` (not `CONCURRENTLY`) | 3 |
| `0009` | `staging.source_record.missed_polls/.last_seen_scrape_run_id/.last_seen_at/.last_missed_scrape_run_id` (+ 2 FKs to `curated.scrape_run`) | **Missing** | Additive (nullable/fast-default) + FK validation | 145 (+ 8 in `scrape_run`, the FK target) |
| `0010` | `curated.query_snapshot.search_scope` | **Missing** | Additive column + `SET DEFAULT` (metadata-only) | 0 |
| `0011` | `curated.aanvraag.locatie_tekst/.sluitingsdatum` | **Missing** | Additive — nullable columns | 4 |

`curated.query_snapshot` had **0 rows** in the 2026-09-01 readback, so every
backfill/NOT NULL/CHECK constraint `0007` and `0010` added to an empty table.
`curated.scrape_run` (the FK target for `0009`'s two new columns) had 8 rows;
the new FK columns on `source_record` were added as `NULL` with no backfill.
These counts are historical and must not be reused as a live baseline.

## Historical `0006`–`0011` rehearsal against the captured clone

Rather than reason about this from the SQL alone, I `pg_dump`'d the **entire**
live Neon database as it stood on 2026-09-01 (schema + data, same tool as
[neon-export.sh](neon-restore.md)) and restored it into a disposable local
Postgres cluster (`initdb`/`pg_ctl`, no docker), so the migrations ran against
an exact structural and row-count copy of that snapshot — not an empty
`ji_test` database.

```
$ psql (clone) -Atqc "select 'outbox_event', count(*) from curated.outbox_event
                       union all select 'source_record', count(*) from staging.source_record
                       union all select 'aanvraag', count(*) from curated.aanvraag;"
outbox_event|3
source_record|145
aanvraag|4
```

(Matched the captured Neon snapshot exactly — see table above.)

The following is historical output from the commit that ended at `0011`.
Running the same command from the reviewed integration base would also apply
any pending `0012`–`0014`; do not do that until the current gate at the top of
this document is cleared.

```
$ MIGRATION_DATABASE_URL=postgresql://scratch_owner@127.0.0.1:5556/neon_clone drizzle-kit migrate
Using 'postgres' driver for database querying
[✓] migrations applied successfully!
```

Wall time ~2s including Node/drizzle-kit startup overhead — the actual DDL
against 3/8/145/4-row tables is sub-second.

Post-migration verification, same clone:

```
$ psql (clone) -Atqc "select count(*) from drizzle.__drizzle_migrations;"
12
$ psql (clone) -Atqc "select id, sequence_number, retry_count from curated.outbox_event order by sequence_number;"
597f9dc5-...|1|0
2483dc33-...|2|0
824da298-...|3|0
$ psql (clone) -Atqc "select 'outbox_event', count(*) ... union all ..."
outbox_event|3
source_record|145
aanvraag|4
$ psql (clone) -Atqc "select to_regclass('curated.search_projection_checkpoint'),
                              to_regclass('curated.search_projection_state');"
curated.search_projection_checkpoint|curated.search_projection_state
```

In that historical clone, the journal went from 6 to 12 rows,
`sequence_number` was backfilled correctly and in order (1, 2, 3 — matching
`created_at` ascending as `0006`'s `UPDATE` intends), row counts were unchanged
and both new tables existed. Re-running `drizzle-kit migrate` against that
same `0000`–`0011` checkout applied zero further changes. The 12-row result is
not the expected result for the reviewed integration base.

**This is evidence only for `0006`–`0011` against the captured snapshot:** a
real run of those migrations against a byte-for-byte copy of the schema and
data read on 2026-09-01. Combined with the point team-lead raised —
`packages/db/src/migration-upgrade.spec.ts`
(RJC-395) already covers each of `0000→0001` through `0009→0010` and
`0010→0011` step-by-step against synthetic pre-migration data, and was wired
into `bun run gate` via `tools/postgres/ensure-migration-upgrade-db.ts`
(confirmed: `.github/workflows/ci.yml`'s CI job runs `bun run gate`, and
`gate.sh` hard-fails in CI if this suite's database is unreachable rather
than silently skipping it) — the two results together cover both ends: sound
from-scratch with synthetic data (CI) and sound for `0006`–`0011` against the
captured Neon snapshot. The cited historical evidence did not cover `0012`.
Current code has a synthetic `0011→0012` upgrade test, but that is not a
rehearsal against a Neon clone and not live proof. No migration-upgrade test
in this integration base exercises `0012→0013→0014` against existing rows;
the current-snapshot rehearsal below is therefore a hard gate, not optional
extra evidence.

## Lock class and measured duration — per migration file

Measured by applying each pending migration file individually (not batched)
against a fresh clone of the captured 2026-09-01 Neon data, `psql -f` per
file, timed with sub-millisecond precision. This is a **repeat of RJC-381's
rehearsal**, re-run on 2026-09-01 with per-file (not just whole-run) timing, plus one
targeted probe isolating the `int→bigint` rewrite specifically (add a
throwaway `integer` column to `curated.outbox_event`, widen it to `bigint`,
drop it — same operation `0007`/`0008` perform, on the same table/row-count):

| Migration file | Lock class (per Postgres docs) | Wall time (whole file, incl. psql startup) | Isolated statement cost |
|---|---|---:|---:|
| `0006_search_projection_checkpoint.sql` | `ACCESS EXCLUSIVE` (backfill `UPDATE`, `SET NOT NULL`, `ADD GENERATED`) + `SHARE` (unique index build) | 97ms | — |
| `0007_snapshot_search_version.sql` | `ACCESS EXCLUSIVE` (`ALTER COLUMN TYPE`, `SET NOT NULL`) | 88ms | **20ms** (isolated `int→bigint` probe, see below) |
| `0008_bulk_projector_claims.sql` | `ACCESS EXCLUSIVE` (`ALTER COLUMN TYPE`, fast-default adds) + `SHARE` (2 partial indexes) | 114ms | same 20ms class (identical operation, same table) |
| `0009_source_record_missed_polls.sql` | `ACCESS EXCLUSIVE` (fast-default adds) + `SHARE ROW EXCLUSIVE` (2 FK adds, validated against 8 `scrape_run` rows) | 84ms | — |
| `0010_query_snapshot_search_scope.sql` | `ACCESS EXCLUSIVE` (add column, `SET DEFAULT` is metadata-only) | 71ms | — |
| `0011_aanvraag_locatie_sluitingsdatum.sql` | `ACCESS EXCLUSIVE` (nullable column adds, PG11+ fast path — no rewrite) | 68ms | — |

Isolated `int→bigint` probe (the operation team-lead specifically flagged as
the one expected to actually rewrite a table):

```sql
\timing on
ALTER TABLE curated.outbox_event ADD COLUMN _timing_probe integer;   -- Time: 3.062 ms
ALTER TABLE curated.outbox_event ALTER COLUMN _timing_probe TYPE bigint;  -- Time: 20.391 ms
ALTER TABLE curated.outbox_event DROP COLUMN _timing_probe;          -- Time: 0.234 ms
```

`int→bigint` is a genuine table rewrite (not binary-coercible — the on-disk
width changes from 4 to 8 bytes, so Postgres does not skip it the way it
skips a same-width type change), and it does hold `ACCESS EXCLUSIVE` — the
strongest lock, blocking all reads and writes on the table — for the full
duration. At 3 rows (`outbox_event`) that duration is **20ms**. `0009` is the
largest table touched (145 rows in `source_record`) and does no rewrite at
all (fast-default column adds + FK validation against only 8 `scrape_run`
rows) — expect its `ACCESS EXCLUSIVE` windows to be shorter than `0007`'s,
not longer.

With the pinned `drizzle-orm` 0.45.2 Postgres migrator, one invocation wraps
**all pending migration files in one transaction**. It reads only the latest
live `created_at` and applies each checked-in migration whose journal
`when`/`folderMillis` is newer. The stored SHA-256 hash is written to the
journal for evidence, but it is **not** used to select pending files. A
failure therefore rolls back every file applied by that invocation; rows
from an earlier successful invocation remain applied.

## Historical concurrency conclusion for `0006`–`0011`

**The old rehearsal concluded that `0006`–`0011` needed no stop-the-world
window at the measured 2026-09-01 row counts.** This is not authorization to
run the integrated release, does not cover `0012`–`0014`, and must be
refreshed against the live state before execution. Historical reasoning:

- Every `ACCESS EXCLUSIVE` window measured here is single-digit-to-double-digit
  milliseconds. A concurrent query from the worker or projector that needs the
  same table queues for, at most, tens of milliseconds — not a perceptible
  outage, and well under any client-side timeout in this codebase.
- The poller's and worker's writes to these tables (on-box poll cycles, `drain-outbox`) are short,
  single-statement-per-row transactions, not long-held ones — there is no
  scenario here where the migration would queue for minutes behind an open
  worker transaction the way it could on a system with long-running batch
  writes.
- `0006`'s `CREATE UNIQUE INDEX` and `0008`'s two `CREATE INDEX` statements are
  **not** `CONCURRENTLY` (per the actual SQL in
  `packages/db/src/migrations/`), so each briefly takes a `ShareLock` —
  blocks concurrent writes to that one table, not reads, for the index-build
  duration. At 3 rows that build is effectively instant; this only becomes a
  real concern at row counts where an index build takes seconds, which is not
  where the captured snapshot was.
- One operational footnote, not a lock-contention issue: if Neon's compute is
  autosuspended (scale-to-zero) when the migration starts, the **first**
  connection incurs Neon's cold-start latency (documented as up to a few
  seconds) before any SQL runs — budget for that in how the operator times the
  run, but it does not change the lock-safety verdict above.

**Re-run this same measurement against current volume before relying on it**
(see
[neon-restore.md](neon-restore.md)'s quarterly checklist) — the "trivial at
this row count" verdict was explicitly a function of the captured near-empty
tables, not a permanent property of these migrations.

## `0015` dedup_groep dedup_key — rehearsed on a Neon branch 2026-09-03

`0015_dedup_groep_dedup_key.sql` adds `curated.dedup_groep.dedup_key`, merges
any groups that share a key (survivor: `handmatig_bevestigd` first, then oldest
`created_at`, then `id`; aanvragen are repointed before losers are deleted),
backfills `dedup_key` from every `methode` that is an actual key (contains
the U+001F separator), and creates the partial unique index
`dedup_groep_dedup_key_uidx`. The curate store's get-or-create relies on that
index, so the migration must land before or together with the code that
stops writing `methode`.

Pre-check to run against production before applying (read-only). A non-zero
`duplicate_keys` means the merge step will delete that many losing groups and
repoint their aanvragen — expected and deterministic, but read the affected
keys first so the reviewer knows what merged:

```sql
SELECT count(*) AS groups,
       count(*) FILTER (WHERE methode IS NOT NULL AND position(chr(31) IN methode) > 0) AS keyed_groups,
       (SELECT count(*) FROM (
          SELECT methode FROM curated.dedup_groep
          WHERE methode IS NOT NULL GROUP BY methode HAVING count(*) > 1) d) AS duplicate_keys
FROM curated.dedup_groep;
```

Production readback 2026-09-03 13:30 UTC (read-only, `production` branch,
journal at 15 rows = `0000`–`0014` applied): `groups = 209`,
`keyed_groups = 209`, `duplicate_keys = 0`, `curated.aanvraag = 221` (220
grouped). The rehearsal below ran against that state.

**Re-read 2026-09-03 ~19:45 UTC, after the Motian backfill ran with
`NEON_V1_CONCURRENCY=16`:** `groups = 6925`, `keyed_groups = 6925`,
`duplicate_keys = 1` (one surplus group), `curated.aanvraag = 8023` (8022
grouped). The duplicated key has two groups created **7 ms apart**
(`19:33:47.805Z` with 17 aanvragen, `19:33:47.812Z` with 1), neither manually
confirmed — exactly the find-then-insert race this migration closes. On this
data the merge step is no longer a no-op: it repoints that one aanvraag to the
older group and deletes the newer one, leaving one group with 18 aanvragen. Run
the pre-check again immediately before applying; every further concurrent
import until 0015 lands can add duplicates, and each is merged the same way.

Rehearsal: branch `rehearsal-0015-dedup-key-20260903`
(`br-tiny-sea-zacrpksh`, parent `production` at LSN `0/2418CD8`). The five
statements of `0015` were executed as one transaction on that branch via the
Neon SQL API (not via `drizzle-kit migrate`, so the branch's journal still
reads 15 — the journal row is the only thing the migrator would add).
Post-state on the branch: `groups = 209`, `without_key = 0`,
`key_methode_mismatch = 0`, `aanvragen = 221` (220 grouped), dangling links
`0`, index present with the expected definition. A duplicate-key insert on the
branch was rejected with `duplicate key value violates unique constraint
"dedup_groep_dedup_key_uidx"`. Wall time of the transaction was sub-second at
209 rows. The branch was left in place for the operator to inspect and delete;
nothing was written to `production`.

Lock class: `ADD COLUMN` (nullable, no rewrite), two data-modifying CTEs that
touch zero rows on today's data, one `UPDATE` of 209 rows, and a
non-`CONCURRENTLY` unique index build (`SHARE` lock on `dedup_groep` for the
build). All `ACCESS EXCLUSIVE` windows are metadata-only at this size.

## Current readback and post-migration verification matrix

Use these read-only checks both to establish the live preflight and, only if a
migration is actually required and approved, to verify afterward. Each proves
that a migration's objects exist and hold the expected data; the journal count
alone is insufficient.

| Migration | Verification query | Expected result |
|---|---|---|
| `0006` | `SELECT count(*) FROM curated.outbox_event WHERE sequence_number IS NULL;` | `0` |
| `0006` | `SELECT to_regclass('curated.search_projection_checkpoint');` | non-null |
| `0007` | `SELECT count(*) FROM curated.query_snapshot WHERE search_generation IS NULL OR search_applied_sequence IS NULL;` | `0`; the table was empty in the historical snapshot, but live state must be read again |
| `0008` | `SELECT count(*) FROM curated.outbox_event WHERE retry_count IS NULL;` | `0` |
| `0008` | `SELECT to_regclass('curated.search_projection_state');` | non-null |
| `0009` | `SELECT count(*) FROM staging.source_record WHERE missed_polls IS NULL;` | `0` |
| `0010` | `SELECT count(*) FROM curated.query_snapshot WHERE search_scope NOT IN ('active','all');` | `0` |
| `0011` | `SELECT column_name FROM information_schema.columns WHERE table_schema='curated' AND table_name='aanvraag' AND column_name IN ('locatie_tekst','sluitingsdatum');` | 2 rows |
| `0012` | `SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema='staging' AND table_name='source_record' AND column_name='listing_hash';` | 1 row: `listing_hash`, `text`, `YES` |
| `0013` | Run the scope, markering, index, and constraint readbacks below. | Eight non-null `scope_id` columns, `audit_class` non-null with default, the markering table/indexes/constraints present, and zero invalid/null backfilled values. |
| `0014` | Run the role-column, role-constraint, and aggregate-user readbacks below. | `public.user.role` is `text NOT NULL DEFAULT 'recruiter'`, `user_role_check` is validated, and no stored role is outside the four allowed values. |
| `0015` | `SELECT count(*) AS groups, count(*) FILTER (WHERE dedup_key IS NULL) AS without_key, count(*) FILTER (WHERE dedup_key IS DISTINCT FROM methode) AS key_methode_mismatch FROM curated.dedup_groep;` | `without_key = 0` and `key_methode_mismatch = 0` when every pre-0015 `methode` was a real key (true on the 2026-09-03 branch: 209 / 0 / 0); `groups` unchanged from the pre-write baseline unless the pre-check below reported duplicates |
| `0015` | `SELECT indexdef FROM pg_indexes WHERE schemaname = 'curated' AND indexname = 'dedup_groep_dedup_key_uidx';` | one row: `CREATE UNIQUE INDEX ... USING btree (dedup_key) WHERE (dedup_key IS NOT NULL)` |
| `0015` | `SELECT count(*) FROM curated.aanvraag a WHERE a.dedup_groep_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM curated.dedup_groep g WHERE g.id = a.dedup_groep_id);` | `0` (the merge repoints every aanvraag before deleting a losing group) |
| all, reviewed integration base | `SELECT count(*) FROM drizzle.__drizzle_migrations;` | `15` for the base ending at `0014`, `16` once `0015` is included; for any other `DEPLOY_SHA`, derive this dynamically rather than copying a number |
| all | `SELECT 'outbox_event', count(*) FROM curated.outbox_event UNION ALL SELECT 'source_record', count(*) FROM staging.source_record UNION ALL SELECT 'aanvraag', count(*) FROM curated.aanvraag;` | unchanged from a fresh live pre-write baseline; do not use the historical 3 / 145 / 4 counts |

The `0012`–`0014` expectations and 15-entry reference come from the reviewed
integration code. They define what that SHA should look like when fully
applied; they are not a claim that any of those migrations were rehearsed or
observed live.

Read `0013` without returning user-entered values:

```sql
SELECT table_name, column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'curated'
  AND (
    (column_name = 'scope_id' AND table_name IN (
      'aanvraag_markering', 'saved_search', 'query_snapshot',
      'approval_record', 'audit_event', 'external_id_crosswalk',
      'export_attempt', 'external_receipt'
    ))
    OR (table_name = 'audit_event' AND column_name = 'audit_class')
  )
ORDER BY table_name, column_name;

SELECT object_name, to_regclass('curated.' || object_name) AS object_regclass
FROM unnest(ARRAY[
  'aanvraag_markering',
  'aanvraag_markering_user_aanvraag_uidx',
  'aanvraag_markering_scope_user_idx',
  'aanvraag_markering_aanvraag_id_idx',
  'aanvraag_markering_user_id_idx',
  'saved_search_scope_user_idx',
  'query_snapshot_scope_id_idx',
  'approval_record_scope_snapshot_idx',
  'audit_event_scope_actor_idx'
]) AS expected(object_name)
ORDER BY object_name;

SELECT idx.indexrelid::regclass AS object_regclass,
       idx.indisunique, idx.indisvalid, idx.indisready,
       ARRAY(
         SELECT pg_get_indexdef(idx.indexrelid, keys.key_no, false)
         FROM generate_series(1, idx.indnkeyatts) AS keys(key_no)
         ORDER BY keys.key_no
       ) AS key_columns,
       pg_get_indexdef(idx.indexrelid) AS index_definition
FROM pg_index AS idx
JOIN pg_class AS rel ON rel.oid = idx.indexrelid
JOIN pg_namespace AS ns ON ns.oid = rel.relnamespace
WHERE ns.nspname = 'curated'
  AND rel.relname = 'external_id_crosswalk_idempotency_uidx';

SELECT rel.relname AS relation, con.conname, con.convalidated,
       pg_get_constraintdef(con.oid) AS definition
FROM pg_constraint AS con
JOIN pg_class AS rel ON rel.oid = con.conrelid
JOIN pg_namespace AS ns ON ns.oid = rel.relnamespace
WHERE ns.nspname = 'curated'
  AND con.conname IN (
    'aanvraag_markering_aanvraag_id_aanvraag_id_fk',
    'aanvraag_markering_status_check',
    'aanvraag_markering_revision_check',
    'aanvraag_markering_scope_id_check',
    'saved_search_scope_id_check',
    'query_snapshot_scope_id_check',
    'approval_record_scope_id_check',
    'audit_event_actor_type_check',
    'audit_event_audit_class_check',
    'audit_event_scope_id_check',
    'external_id_crosswalk_scope_id_check',
    'export_attempt_scope_id_check',
    'external_receipt_scope_id_check'
  )
ORDER BY relation, con.conname;

SELECT 'aanvraag_markering' AS relation, count(*) AS invalid
FROM curated.aanvraag_markering
WHERE scope_id IS NULL OR btrim(scope_id) = ''
   OR revision < 1
   OR status NOT IN ('relevant', 'niet_relevant', 'gevolgd')
UNION ALL
SELECT 'saved_search', count(*)
FROM curated.saved_search WHERE scope_id IS NULL OR btrim(scope_id) = ''
UNION ALL
SELECT 'query_snapshot', count(*)
FROM curated.query_snapshot WHERE scope_id IS NULL OR btrim(scope_id) = ''
UNION ALL
SELECT 'approval_record', count(*)
FROM curated.approval_record WHERE scope_id IS NULL OR btrim(scope_id) = ''
UNION ALL
SELECT 'audit_event', count(*)
FROM curated.audit_event
WHERE scope_id IS NULL OR btrim(scope_id) = ''
   OR audit_class IS NULL OR audit_class NOT IN ('access', 'effect', 'none')
UNION ALL
SELECT 'external_id_crosswalk', count(*)
FROM curated.external_id_crosswalk
WHERE scope_id IS NULL OR btrim(scope_id) = ''
UNION ALL
SELECT 'export_attempt', count(*)
FROM curated.export_attempt WHERE scope_id IS NULL OR btrim(scope_id) = ''
UNION ALL
SELECT 'external_receipt', count(*)
FROM curated.external_receipt WHERE scope_id IS NULL OR btrim(scope_id) = '';
```

The information-schema, regclass, index-definition, and constraint queries are
safe before `0013`. When `0013` is pending, expect no new column or constraint
rows: the column query returns only the pre-existing nullable `audit_class`
row with no default, the constraint query returns no rows, and the nine
regclass values for the newly introduced table/indexes are null. The
pre-existing `external_id_crosswalk_idempotency_uidx` must still have `target`
as the first of exactly three key columns, no `scope_id` in
`pg_get_indexdef()`, and all three index flags true. When `0013` is applied,
expect nine column rows, nine non-null regclass values, thirteen validated
constraints, and that same unique, valid, ready index rebuilt with exactly
`scope_id`, `target`, `canonical_vacancy_id`, `action_type` in that order; its
full definition must include `scope_id`. A missing index row, another key
order, a false flag, or any other partial result is a journal/schema mismatch.
Run the aggregate `invalid` query only after the information-schema query
proves every referenced column exists; then expect `invalid = 0` for every
relation. An empty `aanvraag_markering` table is covered structurally; do not
invent rows to prove it.

Read `0014` without returning user identifiers:

```sql
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'user'
  AND column_name = 'role';

SELECT conname, convalidated, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'public."user"'::regclass
  AND conname = 'user_role_check';

SELECT count(*) AS invalid_role_count
FROM public."user"
WHERE role IS NULL
   OR role NOT IN ('recruiter', 'operator', 'admin', 'approver');
```

The first two queries are safe before `0014`: expect no role column/constraint
when `0014` is pending, or one `role | text | NO | 'recruiter'::text` column
row and one validated four-role constraint when it is applied. A partial
result is a journal/schema mismatch. Run the aggregate query only when the role
column exists; then expect `invalid_role_count = 0`. These checks intentionally
do not print emails, names, user IDs, or role assignments.

## §4: Operator procedure — blocked at read-only preflight

Do not enter the write phase until the top-of-document gate is cleared. First
capture the full live journal and `0012`–`0014` schema state without modifying
Neon. The live result remains external production evidence; never replace it
with the expectations printed in this document.

```sql
SELECT id, hash, created_at::text
FROM drizzle.__drizzle_migrations
ORDER BY created_at, id;

SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'staging'
  AND table_name = 'source_record'
  AND column_name = 'listing_hash';
```

Also run the `0013` and `0014` readbacks in the matrix above. If journal and
schema disagree (for example, an object exists without its journal entry),
stop and reconcile the inconsistency; do not use `db:migrate` as a diagnostic
or repair command.

Run this deterministic read-only comparison from a trusted repository that
contains the exact 40-character `DEPLOY_SHA`. It reads `_journal.json` and
every SQL blob from that immutable Git commit, even if another branch is
checked out. It then proves the live journal is an exact ordered prefix and
prints the precise pending tags. It prints timestamps, hashes, and migration
tags only; it never prints the connection string or another secret.

```bash
set -euo pipefail
: "${DEPLOY_SHA:?set the full 40-character release commit}"
if test "${#DEPLOY_SHA}" -ne 40 || test -n "${DEPLOY_SHA//[0-9a-f]/}"; then
  echo 'DEPLOY_SHA must be a full lowercase 40-character commit SHA' >&2
  exit 1
fi
git cat-file -e "${DEPLOY_SHA}^{commit}"

migration_path=packages/db/src/migrations
journal_json=$(mktemp)
expected_journal=$(mktemp)
expected_prefix=$(mktemp)
live_journal=$(mktemp)
trap 'rm -f "$journal_json" "$expected_journal" "$expected_prefix" "$live_journal"' EXIT

git show "${DEPLOY_SHA}:${migration_path}/meta/_journal.json" >"$journal_json"
jq -e '
  .entries as $entries
  | (($entries | length) > 0)
    and ([$entries[].idx] == [range(0; ($entries | length))])
    and ([$entries[].when] == ([$entries[].when] | sort | unique))
' "$journal_json" >/dev/null

while IFS=$'\t' read -r folder_millis tag; do
  migration_blob="${DEPLOY_SHA}:${migration_path}/${tag}.sql"
  git cat-file -e "$migration_blob"
  migration_hash=$(git cat-file blob "$migration_blob" | shasum -a 256 | awk '{print $1}')
  printf '%s|%s|%s\n' "$folder_millis" "$migration_hash" "$tag"
done < <(jq -r '.entries[] | [.when, .tag] | @tsv' "$journal_json") \
  >"$expected_journal"

expected_count=$(wc -l <"$expected_journal" | tr -d ' ')
psql "$READONLY_DATABASE_URL" -XAt -F '|' -v ON_ERROR_STOP=1 \
  -c 'SELECT created_at::text, hash FROM drizzle.__drizzle_migrations ORDER BY created_at, id' \
  >"$live_journal"
live_count=$(wc -l <"$live_journal" | tr -d ' ')

if test "$live_count" -gt "$expected_count"; then
  echo 'FAIL: live journal is ahead of the deployment SHA' >&2
  exit 1
fi
awk -F '|' -v count="$live_count" \
  'NR <= count { print $1 "|" $2 }' "$expected_journal" >"$expected_prefix"

if ! cmp -s "$expected_prefix" "$live_journal"; then
  echo 'FAIL: live journal is not the exact deployment-SHA prefix' >&2
  diff -u "$expected_prefix" "$live_journal" || true
  exit 1
fi

if test "$live_count" -eq "$expected_count"; then
  echo "PASS: all ${expected_count} deployment-SHA migrations match; pending=none"
else
  echo "PASS: ${live_count}/${expected_count} entries form an exact prefix"
  echo 'PENDING tags:'
  awk -F '|' -v applied="$live_count" 'NR > applied { print $3 }' "$expected_journal"
fi
```

For the reviewed integration base, this derives 15 entries and the ordered
tail `0013_durable_user_writes` then `0014_auth_user_role`. A different
`DEPLOY_SHA` is allowed to have another count or tail; the derived output, not
this prose, is authoritative. Comparing only the latest timestamp can miss a
corrupted or substituted earlier row. Because Drizzle 0.45.2 selects pending
files from the latest `created_at` versus the journal's `when`, a hash or
prefix mismatch is a stop-and-investigate signal, not something a re-run will
repair automatically.

**A Neon branch is a rollback source, not the rollback action itself.** Neon
branches are copy-on-write and near-instant to create (see
[neon-restore.md](neon-restore.md) §1). Never migrate the only pristine branch
while rehearsing: use one branch as the rehearsal source and a child branch as
the writable rehearsal target. After rehearsal, freeze all writers, rerun the
final production preflight, and create and validate a new rollback branch.
Only that completed evidence can be included in the definitive GO immediately
before the production apply. Recovery still requires the controlled
restore/switchover procedure below.

Create an execution record and fill every field from CLI/Console readback;
record identifiers, timestamps, aggregate counts, and durations, never
connection strings or row contents:

| Evidence field | Recorded value |
|---|---|
| Full immutable `DEPLOY_SHA` | `<record exact 40-character SHA>` |
| Verified Neon project and production branch IDs | `<record at execution>` |
| Live journal prefix and exact pending tags | `<record comparator output>` |
| Live `0012`–`0014` preflight | `<record aggregate/object verdicts>` |
| Rehearsal source and target branch IDs/parents | `<record verified readbacks>` |
| Rehearsal duration, journal, objects, and row-count deltas | `<must all pass>` |
| Writer quiescence started / last in-flight write finished | `<record timestamps>` |
| Final rollback branch ID, parent ID, and `created_at` | `<record verified readback>` |
| Definitive operator GO | `<approver, time, DEPLOY_SHA, pending tags, rehearsal verdict, rollback ID/parent/created_at, queryability evidence>` |

### Rehearse the exact pending set on a fresh production snapshot

Use a clean checkout at the exact deployment commit. The migration command
reads files from the checkout, so deriving the expected journal from
`DEPLOY_SHA` is not enough for the write phase:

```bash
test "$(git rev-parse HEAD)" = "$DEPLOY_SHA"
test -z "$(git status --porcelain)"
```

Resolve the real production parent from the current app configuration and
confirm it in Neon; never infer it from a branch name. Create a pristine
rehearsal source from that parent and a writable child from the source.
`--no-secrets` is mandatory because the captured JSON is evidence:

```bash
verified_project_id='<verified-project-id>'
verified_production_branch_id='<verified-production-branch-id>'
neonctl branches list --project-id "$verified_project_id"

rehearsal_source_json="$(
  neonctl branches create --project-id "$verified_project_id" \
    --parent "$verified_production_branch_id" \
    --name migration-rehearsal-source-$(date +%Y%m%d-%H%M%S) \
    --no-secrets --output json
)"
rehearsal_source_id="$(
  printf '%s' "$rehearsal_source_json" | jq -er '.branch.id // .id'
)"
rehearsal_source_readback="$(
  neonctl branches get "$rehearsal_source_id" \
    --project-id "$verified_project_id" --output json
)"
test "$(printf '%s' "$rehearsal_source_readback" | jq -er '.parent_id')" \
  = "$verified_production_branch_id"
printf '%s' "$rehearsal_source_readback" | jq -e '{id, parent_id, created_at}'

rehearsal_target_json="$(
  neonctl branches create --project-id "$verified_project_id" \
    --parent "$rehearsal_source_id" \
    --name migration-rehearsal-target-$(date +%Y%m%d-%H%M%S) \
    --no-secrets --output json
)"
rehearsal_target_id="$(
  printf '%s' "$rehearsal_target_json" | jq -er '.branch.id // .id'
)"
rehearsal_target_readback="$(
  neonctl branches get "$rehearsal_target_id" \
    --project-id "$verified_project_id" --output json
)"
test "$(printf '%s' "$rehearsal_target_readback" | jq -er '.parent_id')" \
  = "$rehearsal_source_id"
printf '%s' "$rehearsal_target_readback" | jq -e '{id, parent_id, created_at}'
unset rehearsal_source_json rehearsal_source_readback
unset rehearsal_target_json rehearsal_target_readback
```

Obtain the rehearsal target's read-only and owner URLs through the secret
manager without echoing them. Point `READONLY_DATABASE_URL` at the target and
rerun the deployed-SHA comparator: it must report the same journal prefix and
pending tags recorded for production. Capture aggregate row counts, then
inject the target owner URL as `MIGRATION_DATABASE_URL` and run exactly once:

```bash
/usr/bin/time -p bun run db:migrate
```

Rerun the comparator; it must now report `pending=none`. Run every applicable
object query in the verification matrix, including the full `0013` and `0014`
blocks. Prove aggregate row counts did not change unexpectedly, record the
duration/locks, and retain the untouched rehearsal source. A green CI test or
the 2026-09-01 timing is not a substitute for this current-snapshot rehearsal.

### Freeze, final rollback evidence, definitive GO, and production apply

A successful rehearsal may be used to schedule the maintenance window, but it
is not the definitive execution GO. First stop every production database
writer (API, Trigger.dev worker, projector, and operator jobs) and wait for
in-flight transactions to finish. Rerun the deployed-SHA comparator and all
preflight object/aggregate checks with the production read-only role. They
must match the rehearsed pending set. Also prove the migration checkout is
still clean and pinned to that exact SHA.

```bash
test "$(git rev-parse HEAD)" = "$DEPLOY_SHA"
test -z "$(git status --porcelain)"
```

While writers remain stopped, create a fresh rollback branch directly from the
verified production parent, read it back, prove its `parent_id`, retain its
`created_at`, and prove a read-only query succeeds:

```bash
rollback_json="$(
  neonctl branches create --project-id "$verified_project_id" \
    --parent "$verified_production_branch_id" \
    --name pre-migration-${DEPLOY_SHA:0:8}-$(date +%Y%m%d-%H%M%S) \
    --no-secrets --output json
)"
rollback_branch_id="$(printf '%s' "$rollback_json" | jq -er '.branch.id // .id')"
rollback_readback="$(
  neonctl branches get "$rollback_branch_id" \
    --project-id "$verified_project_id" --output json
)"
test "$(printf '%s' "$rollback_readback" | jq -er '.id')" \
  = "$rollback_branch_id"
test "$(printf '%s' "$rollback_readback" | jq -er '.parent_id')" \
  = "$verified_production_branch_id"
rollback_created_at="$(
  printf '%s' "$rollback_readback" \
    | jq -er '.created_at | select(type == "string" and length > 0)'
)"
printf '%s' "$rollback_readback" \
  | jq -e 'select(.id and .parent_id and .created_at) | {id, parent_id, created_at}'
unset rollback_json rollback_readback

psql "$ROLLBACK_BRANCH_READONLY_DATABASE_URL" -XAtqc \
  'SELECT current_database(), pg_is_in_recovery(), now();'
```

Record the successful query timestamp alongside the rollback branch ID,
verified parent ID, and `created_at`. Keep writers stopped and inject the
production owner URL as `MIGRATION_DATABASE_URL` without echoing it.

Only now may the operator issue the definitive GO. It must explicitly bind
`DEPLOY_SHA + exact pending tags + rehearsal target and verdict + rollback
branch ID + verified parent ID + created_at + successful queryability
evidence`. Silence, an earlier rehearsal approval, an old GO, a green build,
or branch creation by itself is not approval. Any SHA, pending-set, schema,
row-count, writer, rollback-branch, or connection change invalidates the GO
and returns the procedure to the appropriate preflight/rehearsal step.

After that GO, perform no further preparation: with the freeze and validated
state unchanged, immediately run the one-shot migrator exactly once:

```bash
bun run db:migrate
```

Using the production **read-only** URL, rerun the full deployed-SHA comparator
and every object/aggregate check. Expect `pending=none`; for the reviewed
integration base that is 15 exact journal entries plus valid `0013` and
`0014` readbacks. Only then deploy/restart compatible API, worker, and
projector code and reopen writes. Preserve the rollback branch until the
retention gate below is explicitly accepted.

### If a migration fails midway

1. **Do not re-run blindly.** Read the error — `drizzle-kit migrate` rolled
   back the single transaction containing every migration that was pending
   at invocation start. The schema is therefore back at the latest previously
   committed journal timestamp; do not infer pending state from hashes.
2. Diagnose against the exact failing file's SQL
   (`packages/db/src/migrations/000N_*.sql`). The historical rehearsal covered
   failure modes for `0006`–`0011` only. It provides no live-data or rehearsal
   evidence for `0012`–`0014`; inspect `listing_hash`, all `0013` scope
   objects, the `0014` role contract, and the journal explicitly before
   deciding any recovery action.
3. If unresolvable quickly, execute a controlled restore/switchover:
   - stop or pause every writer (API writes, Trigger.dev worker and on-host
     projector) and record the last accepted production write time;
   - choose and validate the recovery candidate: the recorded pre-migration
     branch, or a new PITR branch explicitly forked from the verified
     production parent at the approved timestamp. Record candidate branch ID,
     parent ID, recovery timestamp, creation time and time-to-queryable;
   - run the full journal/hash comparison and the object/row-count checks on
     that candidate using read-only credentials;
   - obtain explicit operator approval for the data-loss boundary: switching
     to the pre-migration/PITR branch discards or requires replay of writes
     after its recovery point;
   - switch every database consumer together by updating the secret-managed
     connection URLs for API, worker, projector and migrator to the validated
     candidate branch, redeploy/restart them, then verify `/livez`, `/readyz`,
     worker access and projector progress before reopening writes. Record the
     old and new branch IDs and the exact cutover time. If the chosen Neon plan
     uses an in-place Console restore instead, apply the same write freeze,
     candidate validation and acceptance gates and follow the current Neon
     Console restore workflow; do not improvise a SQL copy into production.
4. Preserve the pre-migration branch after a successful catch-up or
   switchover. Delete it only after the operator explicitly accepts the
   migration/cutover evidence **and** the actual Neon PITR retention plus the
   independent backup/restore policy have been verified and recorded. A
   one-day soak by itself is not a deletion criterion.

## What this does not cover

This only catches up Neon's Postgres schema. It does not touch Manticore
(rebuilt by reindex regardless — see
[search-schema-migration.md](search-schema-migration.md)) and does not
change anything about the role split or restore drill in
[neon-restore.md](neon-restore.md), which remain separate, still-open work.
