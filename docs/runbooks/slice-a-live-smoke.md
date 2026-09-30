# Slice A live ingest smoke

Short runbook for validating TenderNed and Inhuurdesk ingest end-to-end: connector run → Postgres staging → curation → outbox drain → Manticore search.

## Prerequisites

1. Stack up: `docker compose up -d postgres manticore redis` (or full compose).
2. Migrations applied: `bun run db:migrate` from repo root.
3. Copy env:
   - `apps/server/.env` from `apps/server/.env.example`
   - `apps/worker/.env` from `apps/worker/.env.example`
4. Server uses Postgres + Manticore (not in-memory fixtures). Worker needs the same `DATABASE_URL` and `MANTICORE_URL`.

## Fixture smoke (CI-safe, no external HTTP)

Leave `TENDER_NED_LIVE` and `INHUURDESK_LIVE` unset. Connectors read repo fixtures.

```bash
bun apps/worker/scripts/poll-bron-smoke.ts --bron all --test-import
```

Expect small fixture counts (TenderNed 1, Inhuurdesk 2). Activation (`--activate`) fails until a run persists at least the source's activation threshold of distinct source records (default 20; `seed.minimumTestImportObservations` may lower it per source).

## Live smoke

Set in `apps/worker/.env`:

```env
TENDER_NED_LIVE=1
TENDER_NED_TEST_IMPORT_DAYS=14
INHUURDESK_LIVE=1
```

`TENDER_NED_TEST_IMPORT_DAYS` applies only to live test imports, defaults to 14 when unset, and accepts 1–90 days. Increase it when needed to reach the ≥20 distinct source records required for activation; scheduled TenderNed polls keep their one-day window.

Run test-import, curate, and index drain:

```bash
bun apps/worker/scripts/poll-bron-smoke.ts --bron tenderned --test-import --activate
```

Repeat for Inhuurdesk when needed. Activation requires:

- `voorwaarden_status=toegestaan` on the bron row
- A **succeeded** scrape run with `run_kind=test`
- ≥20 distinct `source_record_id` values on that run’s observations

After activation, scheduled polls (`run_kind=poll`) may run; the on-box poller executes poll → curate and defers the outbox drain to the projector (see [onbox-poller.md](./onbox-poller.md)). Remember that in production a source is only polled once its live flag is set.

## Verify search

1. Start API: `bun run dev` in `apps/server` (port 3000).
2. POST `/v1/aanvragen/search` with an empty or keyword body (see `tests/e2e/read-path.spec.ts`).
3. Confirm curated aanvragen from the smoke run appear in hits.

## Trigger.dev (project `proj_xgtjezribvfwcmqktcli`)

- `schedule-enrich-incomplete`: cron `5 * * * *` Europe/Amsterdam, triggers `enrich-incomplete` with dryRun defaults (see `docs/runbooks/enrichment-schedule.md`).
- Polling is no longer here: `schedule-slice-a-polls` and `poll-bron` were deleted with the move to the on-box poller ([onbox-poller.md](./onbox-poller.md)), which reads each bron's own `curated.bron.interval`.
- `drain-outbox`: optional standalone drain only in `SEARCH_PROJECTOR=worker`;
  in `onbox` mode it returns `deferred: true` and the on-box projector owns the
  drain.

Deploy from `apps/worker` after `TRIGGER_SECRET_KEY` is set: `bun run deploy`.

Local task dev: `bun run dev` in `apps/worker`.

## Notes

- Raw payloads land under `RAW_OBJECT_STORE_PATH` (default `.data/raw-objects`).
- Do not enable Spott export for this smoke; no Slice C sources.
- Coolify compose may omit a worker container—Trigger.dev hosts scheduled runs; use the smoke script or `trigger.dev dev` on-box.
- Credit outage / Coolify oneshot poll (no Trigger): see `docs/runbooks/slice-a-oneshot-poll.md`.
