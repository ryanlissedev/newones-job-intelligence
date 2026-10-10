# Bron dashboard runbook (RJC-416 / D10)

Operator monitor for ingest health: web UI `/bronnen`, capability
`get_dashboard_overview` (`GET /v1/dashboard?window=24u|7d|30d`), and
per-bron `get_bron_stats` / scrape-run list+detail.

Role gate: `operator` or `admin` only. Anonymous and other roles are redirected
to `/?toast=forbidden`. The server capability ACL remains the hard boundary.

## Where to look

| Surface | Path / capability |
| --- | --- |
| Overview KPIs + bron cards + trend | `/bronnen?window=7d` |
| Run table + filters | `/bronnen/runs` |
| Single run | `/bronnen/runs/{id}` |
| Overview JSON | `get_dashboard_overview` / `GET /v1/dashboard` |
| Per-bron JSON | `get_bron_stats` / `GET /v1/bronnen/{id}/stats` |
| Runs | `list_scrape_runs` / `get_scrape_run` |
| Health + alerts | `get_bron_health` / `list_alerts` / `ack_alert` |

Windows: product URL uses `24h|7d|30d`; API uses `24u|7d|30d` (`24h` maps to `24u`).

## Signaalcodes (`BronHealthSignalCode`)

Derived by pure `deriveBronHealth` in
`packages/application/src/observability/bron-health.ts`. Levels:
`critical` leads to status kritiek, `warning` to waarschuwing, `info` to gezond/inactief.

| Code | Level | Meaning | Operator action |
| --- | --- | --- | --- |
| `inactive` | info | Bron `actief=false`. Other signals suppressed. | Confirm intentional pause; re-activate when ready. |
| `never_run` | warning | No completed poll run yet. | Check the on-box poller log for `poller_source` or `poller_source_skipped` for this bron (`docs/runbooks/onbox-poller.md`); verify bron config and its live flag. |
| `circuit_open` | critical | Last run circuit status is `open`. | Inspect last failure; fix root cause; wait for cooldown or reset circuit after verified fix. |
| `scheduler_stale` | critical | No poll run across **any** bron within 2x smallest interval (deployment-wide). | Check the on-box poller's `poller_cycle` logs and advisory lock ([onbox-poller.md](./onbox-poller.md)); this is not a single-source bug. |
| `schedule_overdue` | warning (critical if circuit open) | `now` past `next_run_at` + 1x interval + 5 min grace. | Confirm worker heartbeats; inspect that bron's recent runs; escalate if cluster-wide. |
| `recent_failures` | warning (1-2) / critical (>=3) | Failed runs in the rolling 24h window. | Open run detail; map `failure_code` below; fix connector/upstream. |
| `latest_error` | warning | Last finished run failed; detail often `class/code`. | Same as `recent_failures` for the latest code. |
| `silence_open` | warning | Open `bron.stil` / silence alert (HTTP 200 but volume cliff). | Follow `docs/runbooks/source-silence.md`; auto-resolves on the first recovered poll (`system:silence-recovered`), manual ack otherwise. |
| `zero_activity` | info | Recent successful runs with `nieuw=gewijzigd=0`. | Informational — source alive, nothing new. Do not page. |

Card badge on `/bronnen`: **Aandacht** when silence open, circuit open, last run
failed, or zero runs (**Nieuw**); otherwise **Gezond**.

## Failure codes (`lastFailureCode` / connector lifecycle)

Emitted by the connector run lifecycle (`packages/connectors/src/run.ts`).
Detail on health signals may look like `connector/FETCH_FAILED`.

| Code | Class (typical) | Meaning | Action |
| --- | --- | --- | --- |
| `DISCOVER_FAILED` | connector | Discover/list step threw or returned unusable payload. | Check upstream list endpoint, auth, and bron filters; replay one poll. |
| `FETCH_FAILED` | connector | Per-item fetch failed. | Inspect item URL/auth/rate limits; confirm known-hash path still valid. |
| `RAW_STORE_WRITE_FAILED` | storage | Raw object store write failed. | Check S3/minio credentials, bucket, disk; retry after storage healthy. |
| `OBSERVATION_WRITE_FAILED` | db | Observation persistence failed. | Check Postgres connectivity/migrations; look for constraint errors. |
| `CHECKPOINT_WRITE_FAILED` | db | Checkpoint could not be saved. | Fix DB write path; avoid duplicate ownership; do not clear checkpoint blindly. |
| `COMPLETE_WRITE_FAILED` | db | Run completion row failed to persist. | Check `scrape_run` writers; confirm run still claimed by worker. |
| `RUN_OWNERSHIP_LOST` | worker | Another worker stole/expired the claim. | Inspect lease TTL and concurrent pollers; usually self-heals on next schedule. |
| `UNEXPECTED_FAILURE` | connector | Unclassified throw. | Read run error detail/logs; file bug if recurring. |
| `LEGACY_FAILURE` | legacy | Pre-lifecycle failure shape. | Treat like `UNEXPECTED_FAILURE`; prefer migrating that path. |

## First 5 minutes

1. Open `/bronnen?window=24h` (or `7d`). Note **Bronnen met aandacht** and trend.
2. Open the card / `/bronnen/runs` for failed or staled rows.
3. `get_scrape_run` for the failing id — read status, failure code, stripped checkpoint.
4. If many bronnen overdue together, assume `scheduler_stale` / worker outage first.
5. If one bron silent with HTTP 200, use the silence runbook, not fetch failure.
6. After fix: confirm next poll succeeds; `ack_alert` when an alert was open.

## E2E proof (live)

Opt-in Playwright under `e2e/live-jobs`:

- Anonymous: `bron-dashboard-anonymous.playwright.ts` — `/bronnen` redirects, no capability calls.
- Operator: `bron-dashboard.playwright.ts` — KPIs visible; DOM counts equal
  `GET /v1/dashboard?window=7d` via `bron-dashboard-parity.ts`.

Same live guardrails as `/jobs` (`E2E_LIVE=1`, release SHA, session storage state
for the operator lane). Unit coverage: `bun test e2e/live-jobs/bron-dashboard-parity.spec.ts`.

## Related

- Plan: `docs/plans/2026-09-04-feat-bron-dashboard-plan.md` (D10 / RJC-416)
- Silence: `docs/runbooks/source-silence.md`
- Live jobs harness: `docs/runbooks/live-jobs-e2e.md`
