# Source silence runbook (F4 / AE7)

Use this runbook when a Slice A connector returns HTTP 200 but produces zero `new` and zero `changed` records while the 7-day baseline shows a volume drop past the configured threshold.

## Detection

Silence events are emitted by `packages/application/src/observability/silence.ts` after each connector run completes. An open alert contains:

| Field | Meaning |
| --- | --- |
| `bron` | Bron UUID |
| `detectietijd` | ISO timestamp when the anomaly was detected |
| `laatste_succes` | Last known successful ingest timestamp |
| `drempel` | Volume-drop ratio threshold (default `0.5`) |
| `evidence` | Baseline averages, current metrics, HTTP status |
| `eigenaar` | Operator owner mailbox |
| `runbook` | This document path |
| `dedupeKey` | Stable key (`silence:{bronId}:zero-activity-volume-drop`) |

Duplicate identical events are deduped on `dedupeKey` while the alert remains open.

## Auto-resolution

A `bron.stil` alert resolves itself on the first successful poll that writes at least one new or changed record: `recordSucceededRun` in `apps/worker/src/poll-bron-run.ts` acks it with `acked_by = system:silence-recovered` and clears `bron_health.silence_alert_open`, logging `silence_alert_auto_resolved` to stderr. A quiet run (still 0 new/changed) does not resolve the alert even when it no longer trips the volume threshold — silence means no activity, not just no new event. Manual `ack_alert` remains available for any alert the operator handles first.

## Operator steps

1. Open `get_bron_health` / `list_alerts` for the affected bron.
2. Confirm the latest scrape run succeeded (`status=succeeded`, HTTP 200) with `nieuw=0` and `gewijzigd=0`.
3. Compare `evidence.baseline_avg_found` with `evidence.current_found`.
4. Check upstream source availability (TenderNed / Inhuurdesk fixture or live endpoint).
5. If the source is healthy but filters/checkpoints changed, review bron config and resume polling.
6. Acknowledge the alert via `ack_alert` once mitigated or tracked.

## Escalation

CTP-653 routes alerts to an operator channel:

- **Delivery**: the alert row is committed first; `deliverOpenedAlert` POSTs `{text, alert}` to `ALERT_WEBHOOK_URL` only **after** `withSourceHealthTransaction` resolves (Slack incoming-webhook shape; `alert` carries the structured fields). No webhook request is ever made while the source-health row lock is held, and if the transaction rolls back no operator notification is sent — the delivered `alertId` always refers to a committed row. Delivery failure is logged as `alert_delivery_failed` and never fails the poll. Dedupe is unchanged: `findOpenByDedupeKey` guarantees exactly one delivery per *open* alert — a second identical silence event while the alert is still open delivers nothing.
- **Escalation**: once per poller tick, `createAlertEscalator` re-delivers open alerts older than `ALERT_ESCALATION_HOURS` (default 4) with `stage: "escalated"` until the alert is acked. Escalation only runs when `ALERT_WEBHOOK_URL` is set — without a webhook the stderr sink would just repeat `alert_unrouted` every tick.
- **Restart caveat**: the escalated-id set is process-local, so a poller restart may re-escalate a still-open alert once (ADR-0010: the alert table has no mutable column besides `acked_at`; a persisted `escalated_at` is the follow-up if that becomes a problem).
- **No webhook**: `createStderrAlertSink` writes one `alert_unrouted` JSON line per opened alert; delivery failures are logged as `alert_delivery_failed` and never fail the poll.

Env (apps/worker): `ALERT_WEBHOOK_URL` (https webhook URL, empty = stderr fallback), `ALERT_ESCALATION_HOURS` (positive number, default 4).

### Manual test

1. Run a local listener:

```bash
bun -e 'Bun.serve({ port: 8787, fetch: async (r) => { console.log(await r.text()); return new Response("ok"); } })'
```

2. `ALERT_WEBHOOK_URL=http://localhost:8787/hook ALERT_ESCALATION_HOURS=4` in the worker env (`http` is accepted only for loopback hosts; production must be `https`).

Tripping silence end-to-end from the CLI is not wired (the detector needs a successful run plus a 7-day baseline); the honest test path is `bun test packages/application/src/observability/` — `alert-sink.spec.ts` asserts the `opened` delivery, `escalation.spec.ts` the re-notify and retry; `apps/worker/src/poll-bron-run.spec.ts` proves delivery only happens after the transaction commits. To see a real webhook payload, call `deliverOpenedAlert` with the webhook sink against a committed memory/Pg alert row, or temporarily lower the thresholds in a spec harness.

Dashboards and LLM/vision diagnosis still belong to Slice C (JI-032+).

## Related code

- Silence evaluation: `packages/application/src/observability/silence.ts`
- Tests: `packages/application/src/observability/silence.spec.ts`
- Alert API: `list_alerts`, `get_bron_health`, `ack_alert`
