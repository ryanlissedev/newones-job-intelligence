# CTP-654 — restore-drill baseline (ADR-0017)

## Baseline run

- Date: 2026-09-25 (UTC), executed on a macOS host (OrbStack, `linux/amd64`
  emulation) from worktree `ryan1/ctp-654-restore-drill-threshold`, git sha
  `6ef83ea`.
- Command: `DOCKER_DEFAULT_PLATFORM=linux/amd64 bash tools/postgres/restore-drill.sh`
- Fixture: isolated Docker Compose project `catapulze-restore-drill`, source
  Postgres on 55431, restore target on 55432, MinIO archive on 59000.
- Thresholds in force: `RESTORE_DRILL_MAX_RTO_SECONDS=7200`,
  `RESTORE_DRILL_MAX_RPO_SECONDS=900` (ADR-0017 §1 proposals).
- Result: `pass`, exit 0. RTO 9 s (backup-fetch → integrity checks), RPO
  observed 0 s (all WAL archived), total drill 29 s.
- Evidence: [`baseline-2026-09-25.json`](baseline-2026-09-25.json).

## Breach check

A second run with `RESTORE_DRILL_MAX_RTO_SECONDS=1` exited 1 and wrote an
evidence artifact with `result: "fail"` and `breached: ["rto"]` (rto 7 s > 1 s
threshold), proving the gate fails closed and still emits its artifact. That
artifact was verified and discarded; it is not committed.

## Scope

This is the fixture-lane baseline per ADR-0017 §3. It proves the mechanism
meets the proposed thresholds on a small fixture database; it is not evidence
that a production-sized restore finishes within 2 hours.
