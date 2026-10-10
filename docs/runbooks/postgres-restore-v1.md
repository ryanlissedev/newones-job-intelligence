# PostgreSQL restore runbook v1

Version: **1.2**
Status: **The local/CI fixture lane is defined and guarded by CI. The production restore gate is open: current Hetzner/Coolify backup and restore evidence is not recorded here.**
Requirements: **R21, AE9, JI-037, DEC-005**

Production follows [ADR-0011](../adr/ADR-0011-postgres-on-box-trigger-static-ips.md):
the system of record is the dedicated Postgres resource in Coolify on the
Hetzner box. Its deployment contract allows Trigger.dev to reach it through
allowlisted static egress IPs, while Coolify applications use the private
network. Verify the live cutover before treating that contract as operational
evidence. [ADR-0006](../adr/ADR-0006-neon-as-system-of-record.md) is superseded
for production. Motian-Neon remains a read-only import source, never Catapulze's
production database.

This runbook has two separate lanes:

- The repository's Docker/wal-g/MinIO lane proves the isolated fixture path.
- The production lane restores a real off-site backup into a new isolated
  target and records operator evidence. A fixture marker is not a production
  restore check.

## When to use

- Scheduled monthly or quarterly restore drill (AE9)
- Suspected corruption or loss of the on-box production database
- Before the RJC-418 cutover claims the restore gate is complete
- Before claiming current production recovery readiness after backup changes

For the surrounding production and migration sequence, use
[postgres-on-box.md](postgres-on-box.md),
[hetzner-deploy.md](hetzner-deploy.md),
[trigger-on-box-cutover.md](trigger-on-box-cutover.md), and
[neon-migration-catchup.md](neon-migration-catchup.md).

## Safety boundary

1. Restore only into a newly provisioned volume or VM disk. Never restore over
   `POSTGRES_DATA_VOLUME`.
2. Keep the target on loopback or a private network. Do not expose its 5432
   port publicly.
3. Keep production writers away from the target until recovery checks finish.
4. Use operator-injected credentials from the secret manager. Do not put a
   connection string in a command argument, evidence file, or committed file.
5. Destroy the temporary target after the evidence is captured, according to
   the approved operator procedure.

## Local and CI fixture lane

The repository script is the source of truth for the isolated fixture:

```bash
bash tools/postgres/restore-drill.sh
```

The script requires Docker and Bun, defaults to `.env.example`, and uses its
own Compose project (`catapulze-restore-drill` by default). It creates a source
and restore volume, publishes source Postgres on `127.0.0.1:55431`, the target
on `127.0.0.1:55432`, and MinIO on `127.0.0.1:59000`. The ports and project
can be changed with the variables defined in the script. Its exit trap removes
the fixture containers and restore volume.

The fixture path applies migrations, writes `u10_restore_marker`, pushes a
base backup and WAL with wal-g, restores into the separate target, and invokes:

```bash
bash tools/postgres/integrity-checks.sh <restore-container> <marker-value>
```

That helper checks the Drizzle journal, three core relations, and the fixture
marker. The marker is created by `restore-drill.sh`; it is deliberately a
fixture-only assertion and must not be fabricated for a production restore.

The drill enforces the numeric RPO/RTO grens from
[ADR-0017](../adr/ADR-0017-rpo-rto-herstelgrens.md): it fails with exit 1 and a
`result: "fail"` evidence artifact when the measured restore time or observed
replication lag exceeds `RESTORE_DRILL_MAX_RTO_SECONDS` /
`RESTORE_DRILL_MAX_RPO_SECONDS`.

CI runs this script in the `postgres-restore-drill` job and uploads
`.artifacts/postgres-restore-evidence.json`. The repository also has
`tools/postgres/restore-drill.spec.ts`, which guards the drill's isolated
Compose project and source port. A CI job or static guard is evidence for this
fixture lane only; it is not evidence of a current Hetzner restore.

The script's wal-g restore call has the required two positional arguments:

```bash
wal-g backup-fetch <target-data-directory> <backup-name>
```

The target directory comes first and the selected backup name comes second.
Do not use the incomplete `wal-g backup-fetch LATEST` form.

### Ingest-chain restore drill (CTP-632)

The wal-g fixture above proves a marker row survives a restore; it does not
exercise the ingest chain. The complete chain drill is:

```bash
bun tools/backfill/restore-drill.ts [--output .artifacts/restore-drill-receipt.json] [--keep]
```

It needs only the already-running local Postgres and a `pg_dump` (host PATH,
or the Postgres container that actually publishes the credentials' port and
authenticates the drill roles). It creates two disposable
`ji_restore_drill_*` databases — it never touches `ji_test` or any other
database — and runs the real ingest path against the registered
`opdrachtoverheid` source with a deterministic in-process connector (no live
egress, no production payloads):

1. Provision and migrate the source as `ji_migrator`; seed one synthetic bron.
2. Offer a durable `bron-ingest` job and take it through
   `runBronIngestPipeline`: `scrape_run`, `staging.source_record`,
   `staging.aanvraag_observation`, `curated.aanvraag`, the durable-job row
   and an outbox event all land through the real code path.
3. Offer a second job whose connector fails mid-crawl: the run is left
   `failed` with a persisted checkpoint and the queue row stays open.
4. `pg_dump` the source, then let the same job retake and succeed — the
   commits between dump and loss are the exposure window the restore cannot
   contain.
5. `DROP DATABASE` the source and restore the dump into a fresh database;
   the restored snapshot must equal the state at backup byte-for-byte at the
   row level the drill tracks.
6. Retake the unfinished durable job on the restored database: it resumes
   the same `scrape_run` from its checkpoint under a new fence token. A
   final poll rediscovers both fixture items and must produce no duplicate
   `aanvraag` or `source_record` rows.

The receipt is machine-readable JSON: git SHA, per-step status/timing/exit
codes, dump path + SHA-256, row counts at backup / before loss / restored /
reconstructed, the lost-writes list, the RPO exposure window (backup → loss)
and measured RTO (loss → consistent state), verification outcomes, search
projection status, and whether cleanup dropped both databases.
`bun test tools/backfill/restore-drill.integration.spec.ts` reruns the drill
inside the suite whenever the local Postgres is reachable.

What this proves: a logical `pg_dump` round-trip preserves the whole ingest
chain — durable queue rows, run checkpoints, staging records, curated rows
and outbox — and the durable-job retake plus replay stay idempotent after a
database loss. What it does **not** prove: production restore readiness
(local fixture, not the Hetzner backup chain), search index state (receipt
reports `unknown`; the projector/Manticore is not exercised — the outbox is
the recoverable evidence), or accepted numerical RPO/RTO targets. Observed
locally: exposure ≈ 150 ms and restore-to-consistent ≈ 0.4–0.6 s, reported
against the `postgres-on-box.md` policy numbers as measurements only.

## Production restore drill

ADR-0011 scopes Coolify backups to an off-site Cloudflare R2 bucket and keeps
the restore drill as an RJC-405 prerequisite before the on-box cutover. Read
back the deployed Coolify/Postgres backup configuration before choosing a
restore procedure: ADR-0011 and [postgres-on-box.md](postgres-on-box.md) name
physical WAL archiving as a policy option, but this repository does not prove
that the live resource uses wal-g.

Use one of these lanes only after its source format and backup chain are
verified:

| Verified source | Required restore evidence |
| --- | --- |
| Physical wal-g base backup plus continuous WAL | `wal-g backup-list`, then `wal-g backup-fetch <target-data-directory> <backup-name>`, WAL replay with the verified `restore_command`, and the recovery checks below. Record base-backup age `< 26h`, latest WAL age `< 15m`, and retention `>= 7 days` as required by [postgres-on-box.md](postgres-on-box.md). |
| Logical `pg_dump` or provider export | Use the exact verified `pg_restore` or `psql` procedure for that artifact format, roles, and schemas. This runbook does not invent that command. Record the isolated rehearsal and readback; both remain unresolved here. |

The following is the evidence sequence; it does not claim that any step has
already been completed. The recovery targets remain RPO `<= 1 hour` and RTO
`<= 4 hours`, per the on-box policy.

| Step | Evidence to capture | Current status |
| --- | --- | --- |
| 1. Identify the source | Coolify/Postgres resource, verified backup format, exact backup name or dump artifact, WAL position where applicable, operator and UTC time | **Unresolved in this repository** |
| 2. Provision the target | New isolated volume/disk, private bind, no production volume attached | **Unresolved** |
| 3. Fetch or restore the source | Physical lane: `wal-g backup-list` and successful `wal-g backup-fetch <target-data-directory> <backup-name>`. Logical lane: the verified `pg_restore`/`psql` procedure for the captured artifact. | **Unresolved** |
| 4. Replay or complete recovery | Physical lane: `recovery.signal`, verified `restore_command = 'wal-g wal-fetch %f %p'`, promotion result, recovery LSN/timestamp. Logical lane: completion and readback of the verified restore procedure. | **Unresolved** |
| 5. Check the restored database | Migration journal, required relations, constraints/indexes, row/checksum comparison against the captured source evidence | **Unresolved** |
| 6. Exercise the application read path | Approved non-PII read through the server/API path after the target is ready | **Unresolved** |
| 7. Measure recovery | Start/end UTC timestamps and calculated RPO/RTO against policy | **Unresolved** |
| 8. Clean up | Target destruction and confirmation that production volume and credentials were untouched | **Unresolved** |

Run `tools/postgres/integrity-checks.sh` only for the local/CI fixture because
its contract requires the fixture marker. For production, record read-only
SQL results for the journal and schema objects, compare the restored data with
the source evidence, and record the approved API read in the evidence
template. Do not insert a synthetic marker into the production target merely
to satisfy the fixture helper.

## Migration and pre-migration evidence

ADR-0011 replaces Neon branching as the rollback mechanism with a `pg_dump`
before each migration. The dump must be stored in the operator-approved
protected location, with its SHA/size, source identity, UTC timestamp, and
restore/readback result recorded in the change evidence. A dump alone is not a
restore rehearsal.

The current repository does not contain a current production pre-migration
dump, an isolated rehearsal of that dump against the pending migration set, or
a recovery readback tied to the live on-box database. Treat those items as
open gates. The historical Neon material and
[neon-migration-catchup.md](neon-migration-catchup.md) are migration context;
they do not establish current production restore evidence.

## Evidence record

Copy [the restore evidence template](../review/postgres-restore-evidence-template.md)
for each drill. Record the exact git SHA, backup name, recovery point, target
identity, migration journal result, schema/data checks, API read, elapsed
time, and cleanup result. Keep secrets and raw connection strings out of the
record.

Do not mark the production restore gate passed from a Compose healthcheck, a
successful backup upload, a fixture marker, or a historical Neon rehearsal.
The production claim requires the completed isolated drill and its attached
operator evidence.

## Failure handling

| Symptom | Likely cause | Action |
| --- | --- | --- |
| Physical backup chain cannot be listed or fetched | Wrong target credentials, bucket access, backup name, or missing WAL | Stop; preserve the error and inspect the operator-approved backup configuration |
| Logical dump restore fails | Wrong artifact format, roles, schemas, or unverified restore procedure | Keep the target isolated; capture the failure and verify the provider/operator procedure before retrying |
| Physical recovery does not promote | Incomplete fetch, invalid `restore_command`, or missing WAL | Keep the target isolated; capture logs and correct the physical restore procedure before retrying |
| Journal or required relation is missing | Backup predates the expected schema or the wrong target was restored | Stop the claim; compare the exact backup and release SHA, then repeat with a verified backup |
| Data comparison differs | Corruption, wrong recovery point, or incomplete WAL replay | Do not switch production; preserve the target and escalate with the captured comparison |
| Target is publicly reachable | Incorrect bind or firewall rule | Stop the drill and close the port before continuing |

## Version history

| Version | Date | Change |
| --- | --- | --- |
| 1.2 | 2026-09-21 | Added the CTP-632 ingest-chain restore drill (`tools/backfill/restore-drill.ts`) and its receipt to the local lane; production gate remains open. |
| 1.1 | 2026-09-19 | Re-scoped production to ADR-0011 on-box Postgres, corrected wal-g syntax, separated fixture marker checks from production evidence, and recorded unresolved restore gates. |
| 1.0 | 2026-08-30 | Initial local/CI MinIO fixture drill. |
