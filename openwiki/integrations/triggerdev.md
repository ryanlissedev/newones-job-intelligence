---
type: Integration
title: Trigger.dev Integration
description: Describes the use of Trigger.dev for retained jobs (enrich-incomplete, schedule-enrich-incomplete, drain-outbox, backfill-neon-v1) and how they integrate with the system.
tags: [triggerdev, integration, jobs]
verified:
  - by: openwiki/0.7.0
    at: 2026-10-10T14:05:56.822Z
sources:
  - id: openwiki-source-01b8bf8256568eef8a6c0f3b
    resource: repo://apps/worker/src/tasks/enrich-incomplete.ts
  - id: openwiki-source-511ab5cc5a1eef5de1adb854
    resource: repo://apps/worker/src/tasks/schedule-enrich-incomplete.ts
  - id: openwiki-source-c84f0370bbd90e232f16f35d
    resource: repo://docs/runbooks/onbox-poller.md
generated: { by: "openwiki/0.7.0", at: "2026-10-10T14:05:56.822Z" }
---

# Trigger.dev Integration

## Overview

<!-- openwiki: broken internal link [../runbooks/onbox-poller.md] file "../runbooks/onbox-poller.md" does not exist. Fix the href or restore the target, then delete this comment. -->
After migrating polling and curation to the on-box poller (see [onbox-poller](../runbooks/onbox-poller.md)), the following jobs remain on Trigger.dev:
- `enrich-incomplete`: Enriches incomplete aanvragen.
- `schedule-enrich-incomplete`: Schedules enrichment jobs.
- `drain-outbox`: Drains the search outbox.
- `backfill-neon-v1`: Backfills data to Neon.

These jobs run in Trigger.dev's hosted compute (us-east-1) and access the same database and object storage as on-box services.

## Retained Jobs

### enrich-incomplete
Performs enrichment of incomplete aanvragen using LLMs and extractors. It can run via:
- **Inline path**: Triggered directly by `schedule-enrich-incomplete` or the durable enrichment queue.
- **Durable path**: Each candidate becomes a queue job; the drain processes jobs and applies enrichment atomically.

<!-- openwiki: broken internal link [../apps/worker/src/tasks/enrich-incomplete.ts] file "../apps/worker/src/tasks/enrich-incomplete.ts" does not exist. Fix the href or restore the target, then delete this comment. -->
See [apps/worker/src/tasks/enrich-incomplete.ts](../apps/worker/src/tasks/enrich-incomplete.ts) for the Trigger.dev task definition.

### schedule-enrich-incomplete
Runs on a cron schedule (every 15 minutes) to trigger enrichment jobs. It queries for incomplete aanvragen and either:
- Invokes `enrich-incomplete` directly (inline path), or
- Enqueues candidates to the durable enrichment queue.

### drain-outbox
Drains the search outbox table, sending events to the search projector to keep the Manticore index updated. This ensures search results reflect the latest curated data.

### backfill-neon-v1
A one-time or occasional job that migrates or backfills data to Neon. Typically run manually or via a temporary schedule.

## Integration Mechanism

### Execution Environment
- Jobs run in Trigger.dev's managed infrastructure (us-east-1).
- They use the same `DATABASE_URL` and object storage credentials (e.g., `RAW_S3_*`) as on-box services.
- The Trigger.dev SDK (@trigger.dev/sdk) defines tasks via `schemaTask`.

### Triggering and Scheduling
- `schedule-enrich-incomplete` uses Trigger.dev's cron trigger.
- Other jobs are triggered by:
  - Direct invocation from schedules or queues.
  - Manual triggers via the Trigger.dev dashboard or CLI.
  - Durable queues (for enrichment and other workflows).

### Data Access
- Jobs import and use the same database clients (@ji/db) and object store clients as on-box services.
- They run inside the same monorepo, sharing types and utilities.
- No code duplication: the core logic (e.g., enrichment, outbox draining) resides in shared packages.

### Observability
- Logs and errors appear in Trigger.dev's dashboard.
- Metrics can be forwarded to the system's observability stack (e.g., via custom logging or telemetry).
- Failed jobs trigger alerts based on Trigger.dev's built-in retry and failure policies.

## Relationship to On-box Services

| Responsibility          | On-box (Poller/Projector)       | Trigger.dev (Retained Jobs)         |
|-------------------------|---------------------------------|-------------------------------------|
| Polling sources         | ✅ (on-box poller)              | ❌                                  |
| Curation backlog        | ✅ (on-box poller)              | ❌                                  |
| Enrichment              | ❌                              | ✅ (enrich-incomplete)              |
| Outbox draining         | ✅ (on-box projector)           | ✅ (drain-outbox) [1]               |
| Scheduled enrichment    | ❌                              | ✅ (schedule-enrich-incomplete)     |
| Data backfills          | ❌                              | ✅ (backfill-neon-v1)               |
| Real-time search updates| ❌                              | ❌ (handled by projector via outbox) |

[1] While the on-box projector owns the outbox drain logic, the `drain-outbox` Trigger.dev job provides an alternative or supplementary draining mechanism, particularly useful during backfills or when the projector is lagging.

## Configuration

Jobs are configured via:
- Environment variables (same as on-box services, e.g., `DATABASE_URL`, `RAW_S3_BUCKET`).
- Trigger.dev dashboard settings (timeout, retry policy, concurrency).
- The `trigger.dev.yaml` file (if present) for project-wide settings.

## Failure Handling and Retries
- Trigger.dev provides automatic retries with exponential backoff.
- Jobs can define custom retry logic (see `enrich-incomplete.ts` for attempt limits).
- Failed jobs are visible in the Trigger.dev dashboard and can be manually retried.
- The on-box poller's `abandonStaleRuns` mechanism does not apply to Trigger.dev jobs; instead, Trigger.dev's own timeout and retry policies govern job lifecycle.

## See Also
<!-- openwiki: broken internal link [../runbooks/onbox-poller.md] file "../runbooks/onbox-poller.md" does not exist. Fix the href or restore the target, then delete this comment. -->
- [On-box poller runbook](../runbooks/onbox-poller.md)
<!-- openwiki: broken internal link [../runbooks/enrichment-schedule.md] file "../runbooks/enrichment-schedule.md" does not exist. Fix the href or restore the target, then delete this comment. -->
- [Enrichment schedule runbook](../runbooks/enrichment-schedule.md)
<!-- openwiki: broken internal link [../runbooks/durable-bron-jobs.md] file "../runbooks/durable-bron-jobs.md" does not exist. Fix the href or restore the target, then delete this comment. -->
- [Durable bron jobs runbook](../runbooks/durable-bron-jobs.md)
