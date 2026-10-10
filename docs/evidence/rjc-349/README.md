# RJC-349 — Measurement contract closure

RJC-349 closes the final measurement-contract gap after D9/RJC-415. The
machine-readable product budget is now versioned in
[`scripts/performance/performance-budgets.json`](../../../scripts/performance/performance-budgets.json)
under `productBudgets`; delivery phases remain observe-only.

## Acceptance checklist

- [x] ADR-0001 through ADR-0004 and the performance record schema remain the
  evidence contract.
- [x] Cohort, reliability, and redaction behavior remains covered by the
  existing performance tests.
- [x] D9 bron-dashboard budgets are encoded in the versioned JSON, with the
  50k-run/12-bron/60-day fixture, round-trip and external-HTTP constraints,
  enforcement mode, and source evidence.
- [x] Delivery-phase absolute thresholds remain `null`; no CI baseline or
  search SLO gate is invented.
- [x] Production PostgreSQL 16 is the dedicated on-box Coolify system of
  record per [ADR-0011](../../adr/ADR-0011-postgres-on-box-trigger-static-ips.md).
  The RJC-418 cutover is complete and `/readyz` returned 200; see the
  [Postgres runbook](../../runbooks/postgres-on-box.md).
- [x] Motian/Neon remains read-only backfill/import infrastructure.

Evidence: [RJC-415 / D9](../rjc-415/README.md).
