# Postgres restore evidence template (AE9 / R21 / JI-037)

Copy this file per drill. Do **not** treat Compose config or a successful backup upload alone as recovery evidence.

## Drill metadata

| Field | Value |
| --- | --- |
| Runbook version | postgres-restore-v1.md v1.1 |
| Date (UTC) | |
| Operator | |
| Environment | `ci-isolated-minio-fixture` / `hetzner-production-drill` |
| Git SHA | |
| Source backup name | |
| Recovery point (LSN or timestamp) | |
| Duration (minutes) | |
| Result | `pass` / `fail` |

## Scope

- [ ] Restored into an **empty isolated** Postgres 16 target
- [ ] Production `POSTGRES_DATA_VOLUME` was **not** mounted on the target
- [ ] Target `5432` bound to private/`127.0.0.1` only
- [ ] Base backup **and** WAL replay completed

## Integrity checks

| Check | Expected | Actual | Pass |
| --- | --- | --- | --- |
| Drizzle journal row count | ≥ 1 | | |
| `staging.source_record` exists | yes | | |
| `curated.bron` exists | yes | | |
| `curated.aanvraag` exists | yes | | |
| Drill marker row readable | yes | | |
| Read-only API/query smoke (production drills) | optional | | |

Command:

```bash
bash tools/postgres/integrity-checks.sh <restore-container> <marker-value>
```

## Backup chain health (production drills)

| Signal | Threshold | Observed | Pass |
| --- | --- | --- | --- |
| Latest WAL upload age | ≤ 15 minutes | | |
| Latest base backup age | ≤ 26 hours | | |
| Retention policy | ≥ 7 days PITR | | |
| Encryption at rest | enabled on bucket | | |

## Remaining ops evidence (production only)

List items that still require Hetzner/Coolify access:

- [ ] External firewall probe confirms public `5432` unreachable
- [ ] Production bucket credentials rotated and distinct from CI MinIO fixture
- [ ] Alert routes tested for disk/WAL/backup staleness
- [ ] Resource limits validated under Manticore rebuild load

## Notes

- CI writes machine-readable output to `.artifacts/postgres-restore-evidence.json` during `postgres-restore-drill`.
- Attach this completed template to the Wednesday review pack when claiming SC6 progress.
