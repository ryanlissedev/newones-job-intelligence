# Neon restore and role-split runbook (RJC-381)

Status: **Partially rehearsed.** The off-provider export and the role split
were executed end-to-end in this session with evidence below. The Neon
PITR/branch restore drill was **not** executed — this session had a Neon
Postgres connection string (`NEON_DATABASE_URL`) but no Neon API key,
`neonctl` authentication, or Console access, and none of those exist in this
repo or its secret store yet. The branch-restore section below documents the
exact commands from Neon's own docs (cited) and states plainly what an
operator with Console/API access must run and confirm.

Related: [ADR-0006](../adr/ADR-0006-neon-as-system-of-record.md) ("Nieuwe
verplichtingen", point 2 — backup/restore; point 3 — roles),
[postgres-restore-v1.md](postgres-restore-v1.md) (the CI/local wal-g lane this
does **not** replace), [postgres-on-box.md](postgres-on-box.md) (the role
model this generalises from Docker to Neon).

## What this covers, and what it doesn't

| Component | Covered by | Restore path |
|---|---|---|
| Postgres (Neon) | This runbook | PITR branch restore (operator) + off-provider `pg_dump` (rehearsed here) |
| Manticore | Not this runbook | Fully derived/rebuildable from Neon's outbox via reindex — see [search-projector.md](search-projector.md) and [search-schema-migration.md](search-schema-migration.md). Losing it is an outage, not data loss: `bun run search:new-generation` + reindex rebuilds it from Postgres. |
| Raw connector payloads (S3/filesystem) | Not this runbook | Own lifecycle in the object store — see [raw-object-storage.md](raw-object-storage.md). Not covered by a Postgres dump; a raw payload loss does not lose curated data, only the ability to re-derive it from the original source response. |
| The CI `postgres-restore-drill` job | [postgres-restore-v1.md](postgres-restore-v1.md) | Proves the local/CI Docker + wal-g path only and enforces the numeric RPO/RTO grens from [ADR-0017](../adr/ADR-0017-rpo-rto-herstelgrens.md). It says nothing about Neon and is not superseded by this runbook — keep running both. |

## 1. PITR / branch restore (Neon-native) — NOT rehearsed this session

Neon's instant restore works by branching from a point in a root branch's
history, not by a wal-g-style fetch/replay like the on-box lane. Two ways to
invoke it, both requiring Neon Console or API/CLI access this session did not
have:

### Console (operator)

1. In the Neon Console, open the production branch → **Postgres database
   → Backup & Restore**.
2. Choose **From history**, pick a timestamp or LSN.
3. **For a drill, do not restore the branch in place.** Restoring in place
   (even with "preserve under name") still modifies the production branch's
   pointer — out of scope per this task's constraints ("touching
   production/main data is not" allowed). Instead use **Create branch** from
   that same timestamp against the production branch as parent, which leaves
   production untouched and gives you a disposable branch to verify and then
   delete.

### CLI (`neonctl`) — exact syntax, not run here

```bash
# Create a new branch forked from production's history at a past timestamp
# (RFC 3339). This does not touch the production branch.
neonctl branches create --project-id <project-id> \
  --name restore-drill-$(date +%Y%m%d) \
  --parent production@2026-09-01T00:00:00Z

# Verify row counts / sequence positions against the branch's own connection
# string (from `neonctl branches list` / `neonctl connection-string`), then:
neonctl branches delete restore-drill-<date> --project-id <project-id>
```

Source: Neon docs, [Instant restore](https://neon.com/docs/guides/branch-restore)
(branch-from-timestamp/LSN syntax, `--preserve-under-name` requirement for
in-place restores, "only root branches support instant restore") and
[Point-in-time restore](https://neon.com/docs/introduction/point-in-time-restore)
(retention window, `Settings → Instant restore`).

### What an operator (Ryan) must do that this session could not

1. **Authenticate `neonctl` or generate a Neon API key** (Console → Account
   → API keys) and store it in the secret manager — nothing named
   `NEON_API_KEY` or equivalent exists in this repo's `.env.example` files or
   1Password vault references today. The vault to create it in is
   `Catapulze Development`.
2. **Confirm the actual configured retention window** in Console → project →
   **Settings → Instant restore**. Neon's documented defaults are 6 hours
   (Free) or 1 day (paid plans), configurable up to 7 days (Launch) or 30 days
   (Scale) — [source](https://neon.com/docs/introduction/point-in-time-restore).
   ADR-0006 puts this project on a Launch-tier budget (€60→160/mo), so the
   achievable window is **up to 7 days**, but the project's actual configured
   value has not been read from the Console this session and must not be
   assumed to be the maximum.
3. **Run the branch-create-from-timestamp command above**, then:
   - `SELECT count(*) FROM curated.aanvraag, curated.outbox_event, staging.source_record` (compare against production at the same moment — see baseline below),
   - `SELECT max(sequence_number) FROM curated.outbox_event` if the branch is on a schema new enough to have it (see gap below),
   - record how long the branch took to become queryable as the **measured RTO** (Neon branches are typically near-instant — copy-on-write — but this must be measured, not assumed).
4. **Delete the drill branch** immediately after recording evidence.
5. Paste the timestamp used, the branch id, the row-count comparison, and the
   time-to-queryable into this runbook's evidence section below, replacing
   this paragraph.

### Baseline captured this session (2026-09-01, for the operator to diff against)

Read-only queries against the current Neon database (`neondb_owner`,
Postgres 18.6, `neondb`), not a branch — **no schema or data was changed**:

| Table | Row count |
|---|---:|
| `curated.aanvraag` | 4 |
| `curated.outbox_event` | 3 |
| `staging.source_record` | 145 |

**Schema-version gap found while gathering this baseline:** the Drizzle
migration journal on Neon (`drizzle.__drizzle_migrations`) shows only 6
migrations applied (`0000`–`0005`); the repo's migration set on `main` goes
through `0011`. `curated.outbox_event` on Neon has 8 columns (no
`sequence_number`, `claimed_until`, `retry_count`, etc. from migration
`0006`+), so the `max(sequence_number)` query this task asked for cannot run
against the live Neon database as it stands today — it errors with `column
"sequence_number" does not exist`. This is a real, current gap between `main`
and the deployed Neon schema, unrelated to this ticket's role/restore scope,
but confirmed to be a hard deploy blocker (not a gradual degradation) once
quantified. Full per-migration facts, a real rehearsal against a clone of
Neon's actual data, and the operator procedure (with a Neon branch as the
rollback) are in
[`docs/runbooks/neon-migration-catchup.md`](neon-migration-catchup.md) — not
executed against Neon itself this session.

## 2. Off-provider export — rehearsed this session

`tools/postgres/neon-export.ts` is a shell script (`.sh`; matches every other
file in `tools/postgres/`, which is bash, not TypeScript — see Judgment
calls). It `pg_dump`s Neon in custom format (`-Fc`, the only format
`pg_restore` can selectively/parallel-restore from) to a local path, then
optionally restores into a throwaway local Postgres cluster to verify.

```bash
export NEON_DATABASE_URL=...   # from apps/worker/.env, never echoed
bash tools/postgres/neon-export.sh /path/to/backup.dump --verify
```

The `--verify` path needs `pg_dump`/`pg_restore`/`initdb`/`pg_ctl`/`psql` on
`PATH`, matching Neon's server major version where possible (see Judgment
calls) — e.g. `brew install postgresql@18 && export
PATH="$(brew --prefix postgresql@18)/bin:$PATH"` on macOS. It spins up a
disposable local Postgres cluster bound to a Unix socket only (no TCP
listener, no docker), restores into it, compares one table's row count and a
UTC-normalised `jsonb` checksum against Neon, then tears the cluster down
unconditionally (`trap cleanup EXIT`).

### Evidence — real rehearsal run, 2026-09-01

```
neon-export: dumping Neon to <path> (custom format)
neon-export: wrote 106630 bytes in 2s
neon-export: --verify — restoring into a throwaway local Postgres cluster
neon-export: local restore took 1s (warnings, if any, in <tmp>/restore.log)
neon-export: comparing row count for curated.aanvraag
neon-export: curated.aanvraag row count — Neon=4 restored=4
neon-export: computing a table checksum (md5 of ordered row hashes) for curated.aanvraag
neon-export: curated.aanvraag checksum — Neon=ae382b42b40aecb1cbfe06c174df6515 restored=ae382b42b40aecb1cbfe06c174df6515
neon-export: VERIFY PASSED — row count and checksum match for curated.aanvraag
```

106 KB / 2s reflects the current P0-scale dataset (4 curated aanvragen, 145
staging source records); re-run this drill after real ingest volume lands and
update this evidence, since export duration will grow with data size in a way
a 106 KB run cannot predict.

**Rehearse quarterly** (same cadence as the on-box restore drill in
[postgres-on-box.md](postgres-on-box.md)). Each rehearsal should check:

- export duration and size trend (a sudden drop usually means a connection/
  auth failure that still exited 0 — verify the file is non-trivial size, not
  just "the command didn't error");
- the `--verify` row-count and checksum still pass on a second table, not
  only `curated.aanvraag` (pass `NEON_EXPORT_VERIFY_TABLE=schema.table`);
- that the export destination itself (wherever the operator copies the
  `.dump` file to — e.g. Hetzner Object Storage) still has valid credentials
  and lifecycle policy;
- whether the schema-version gap noted above has been closed (i.e. Neon is
  current with `main`'s migrations) — if so, delete this note.

This script produces a **local file**; pushing it to Hetzner Object Storage
(or any off-provider destination) is a separate, deliberate step for the
operator using existing rclone tooling — not automated here, since that
destination and its credentials are not yet defined in this repo.

## 3. Role split — prepared and tested locally, NOT run against Neon

`tools/postgres/neon-roles.sql` creates `ji_migrator`, `ji_app`, and
`ji_readonly` on Neon with the least-privilege model ADR-0004 required,
generalised from the on-box bootstrap
(`tools/postgres/init/10-bootstrap-roles.sh`, which only handles the `public`
schema for a fresh local database) to this project's four live schemas:
`public` (Better Auth tables), `curated`, `staging`, `marts`.

**This session did not run it against Neon.** Per the task's constraint
("do not execute the role creation against Neon unless provably safe and
reversible"), it was tested against a disposable local Postgres cluster
instead (see Evidence below) and is otherwise unrehearsed.

### Component → role → env var mapping

| Component | Role | Env var | Notes |
|---|---|---|---|
| `bun run db:migrate` (Drizzle, `drizzle-kit migrate`) | `ji_migrator` | `MIGRATION_DATABASE_URL` | Required explicitly by `packages/db/drizzle.config.ts`; missing/empty fails before Drizzle connects. `DATABASE_URL` is never a fallback. |
| `apps/server` runtime (API, tRPC) | `ji_app` | `DATABASE_URL` | Server-side `@ji/env/database` requires only `DATABASE_URL` (`packages/env/src/database.ts`). |
| `apps/server` projector (`bun run projector`) | `ji_app` | pooled `DATABASE_URL` + direct `PROJECTOR_DATABASE_URL` | Data queries may stay pooled; the session-level advisory lock must use the direct Neon endpoint for the same branch/database. Both use the app role and need DML, not DDL. |
| `apps/worker` Trigger.dev tasks (`drain-outbox`, `backfill-neon-v1`, `enrich-incomplete`) and the on-box poller (`docs/runbooks/onbox-poller.md`) | `ji_app` | `DATABASE_URL` | Confirmed this session: `apps/worker/.env`'s `DATABASE_URL` is currently **identical** to `NEON_DATABASE_URL` — i.e. the worker is already running every query as `neondb_owner` today. |
| Operator verification queries / reporting (row counts, this runbook's checks, a future BI/reporting connection) | `ji_readonly` | none wired yet — a new `READONLY_DATABASE_URL` or ad hoc operator connection string | Not consumed by any app code today; exists so a human or script never needs `ji_app`'s write access (or the owner role) just to read. |

**What breaks if the app keeps using `neondb_owner`:** nothing functionally —
the owner role can do everything `ji_app`/`ji_migrator` can and more. The
risk is blast radius, not capability: a bug, a compromised dependency, or a
leaked `DATABASE_URL` today grants DDL and superuser-adjacent Neon
project-owner privileges, not just DML on four schemas. This is exactly the
gap ADR-0006 flagged and RJC-371 (credential rotation) responded to for a
leaked value — the role split is the structural fix so the next leak is
scoped to what that credential can actually do.

### Evidence — local rehearsal, 2026-09-01

Ran against a disposable local Postgres cluster (`initdb`/`pg_ctl`, no
docker) with the same four schemas and a stand-in `curated.aanvraag` table:

```
$ psql ... -f tools/postgres/neon-roles.sql
CREATE ROLE
CREATE ROLE
CREATE ROLE
ALTER ROLE
ALTER ROLE
ALTER ROLE
GRANT
GRANT
GRANT
DO
   rolname   | can_login | is_superuser | can_create_role | can_create_db
-------------+-----------+--------------+-----------------+---------------
 ji_app      | t         | f            | f               | f
 ji_migrator | t         | f            | f               | f
 ji_readonly | t         | f            | f               | f
(3 rows)
```

Enforcement checks, same run:

```
ji_app INSERT + SELECT on curated.aanvraag:            OK (count=1)
ji_app CREATE TABLE in curated (expect denied):         ERROR: permission denied for schema curated
ji_readonly SELECT on curated.aanvraag:                 OK (count=1)
ji_readonly INSERT on curated.aanvraag (expect denied):  ERROR: permission denied for table aanvraag
ji_migrator CREATE TABLE in curated (expect allowed):    OK (created + dropped)
```

Re-running the same script a second time (idempotency check): every
`CREATE ROLE` line correctly skipped (`WHERE NOT EXISTS` guard), `ALTER ROLE`/
`GRANT`/`DO` re-ran cleanly with no errors.

### Verification query (also embedded at the end of the SQL file)

```sql
SELECT rolname, rolcanlogin AS can_login, rolsuper AS is_superuser,
       rolcreaterole AS can_create_role, rolcreatedb AS can_create_db
FROM pg_roles
WHERE rolname IN ('ji_migrator', 'ji_app', 'ji_readonly')
ORDER BY rolname;
```

Expect three rows, `can_login = t`, all other flags `f`.

### Running it on Neon (operator, one time)

```bash
# Owner connection string — the only one with rights to CREATE ROLE.
export NEON_OWNER_DATABASE_URL=...   # from apps/worker/.env NEON_DATABASE_URL, never echoed

# Generate three strong, distinct passwords (do not reuse any existing value).
psql "$NEON_OWNER_DATABASE_URL" \
  --set ON_ERROR_STOP=1 \
  --set migrator_password="$(op read 'op://Catapulze Development/neon-ji-migrator/password')" \
  --set app_password="$(op read 'op://Catapulze Development/neon-ji-app/password')" \
  --set readonly_password="$(op read 'op://Catapulze Development/neon-ji-readonly/password')" \
  -f tools/postgres/neon-roles.sql
```

The vault is `Catapulze Development`. The three item names above are
placeholders: no item exists yet for these role passwords, so the operator
creates them in that vault before running the command. The production
connection secrets that already exist live in the same vault, on the item
`Job Intelligence production`, as fields rather than as separate items. The
fields confirmed on that item are `DATABASE_URL`, `R2_ACCESS_KEY_ID`,
`R2_SECRET_ACCESS_KEY`, and `R2_S3_API_ENDPOINT`; reference them as
`op://Catapulze Development/Job Intelligence production/DATABASE_URL` and so
on. Do not assume any other field name on that item without reading it first. After it runs, build each role's
connection string (same host/db as `NEON_DATABASE_URL`, different
user/password) and:

1. Set `MIGRATION_DATABASE_URL` (server + CI deploy step) to the `ji_migrator`
   URL.
2. Set pooled `DATABASE_URL` (server, worker, projector data path) to the
   `ji_app` URL. Set direct `PROJECTOR_DATABASE_URL` on the projector to the
   same branch/database and role, without a `-pooler` host.
3. Store the `ji_readonly` URL in the secret manager for operator/reporting
   use; nothing in the codebase needs to consume it yet.
4. Run the verification query above against Neon directly and confirm the
   same three-row, all-`f`-except-`can_login` result.
5. **Do not delete or downgrade `neondb_owner`** — Neon requires an owner role
   to exist, and future `neon-roles.sql` re-runs (e.g. password rotation)
   need it.

## Quarterly rehearsal checklist

- [ ] Off-provider export: run `neon-export.sh --verify`, confirm size/duration
      trend and checksum pass, confirm the destination bucket/credentials
      still work.
- [ ] Branch restore: create a drill branch from a recent timestamp, compare
      row counts/sequences to production at that moment, measure
      time-to-queryable, delete the branch.
- [ ] Confirm the Neon Console's configured retention window still meets the
      RPO this project needs, re-checking after any plan tier change.
- [ ] Confirm the three roles still exist with the expected flags (query
      above) and that `MIGRATION_DATABASE_URL`/`DATABASE_URL` still point at
      the intended roles, not back at `neondb_owner`.
- [ ] Re-check whether the Neon schema-version gap has been closed — see
      [`neon-migration-catchup.md`](neon-migration-catchup.md) (as of
      2026-09-01, migrations `0006`–`0011` were not yet applied to Neon).
