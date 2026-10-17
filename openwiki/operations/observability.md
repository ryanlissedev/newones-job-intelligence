---
type: concept
title: Observability, Monitoring, and Alerting
description: A system for tracking source health, data freshness, and pipeline reliability through telemetry, discovery floor monitoring, and alerting mechanisms.
tags: [observability, monitoring, alerting, telemetry]
verified:
  - by: openwiki/0.7.0
    at: 2026-10-17T11:51:19.756Z
sources:
  - id: openwiki-source-3e9879655d6fa23aa6031b93
    resource: repo://apps/worker/src/poller/telemetry-callback.ts
  - id: openwiki-source-aefbc51b6fbda2329d722a5e
    resource: repo://packages/application/src/observability/alert-sink.ts
  - id: openwiki-source-153d6266495cd35fd9026c6a
    resource: repo://packages/application/src/observability/discovery-floor.ts
  - id: openwiki-source-25ebe47742c92c85524b3e8f
    resource: repo://packages/application/src/observability/source-health-signals.ts
  - id: openwiki-source-25043b7054af1bc4a2c52620
    resource: repo://packages/application/src/observability/writer.ts
generated: { by: "openwiki/0.7.0", at: "2026-10-17T11:51:19.756Z" }
---

## Overview

The observability subsystem provides health signals, discovery floor monitoring, and alerting for data sources and ingestion pipelines. It emits telemetry from the poller, derives source health signals from runtime observations, detects silent failures via discovery floor thresholds, and routes alerts through configurable sinks.

## Source Health Signals

Source health signals aggregate multiple dimensions of source viability into a unified health contract. The system derives five independent signals—process liveness, database availability, advisory lock ownership, progress tracking, and data freshness—then combines them into an aggregate state.

Each signal follows a consistent structure: a state (`ok`, `progressing`, `stale`, `failed`, `unknown`, `inactive`, or `blocked`), a reason code, an observation timestamp, and an age in milliseconds. Signals are derived from runtime inputs without direct database access, allowing adapters to supply observations while preserving signal semantics.

### Signal Derivation

- **Process health** evaluates worker heartbeat freshness against a configurable threshold. A missing or stale heartbeat indicates a dead or unresponsive worker.
- **Database health** reflects availability and last probe time from the runtime's database connectivity check.
- **Advisory lock health** tracks whether the source's advisory lock is held, waiting, lost, or unreported, with staleness evaluated against a lock observation threshold.
- **Progress health** distinguishes between no active run, progressing work, and stalled progress based on phase-specific budgets (run or curation) and milestone observations.
- **Freshness health** measures time since the last fully successful run, factoring in current run states (incomplete, backlogged, parked, unknown) and a freshness policy threshold.

The aggregate state prioritizes critical failures: inactive or blocked sources override all other signals, followed by database unavailability, then worker death (stale process signal). Progress and freshness staleness only affect the aggregate when liveness and database signals are healthy.

<!-- openwiki: broken internal link [../packages/application/src/observability/source-health-signals.ts] file "../packages/application/src/observability/source-health-signals.ts" does not exist. Fix the href or restore the target, then delete this comment. -->
See [`source-health-signals.ts`](../packages/application/src/observability/source-health-signals.ts) for the pure derivation logic and signal type definitions.

## Discovery Floor

The discovery floor guards against silent collapses to zero found records—a common failure mode where broken selectors, rolled sitemap chunks, or unhandled sitemap indexes produce zero results without triggering conventional health checks. Unlike ratio-based silence detection, the discovery floor uses a hard zero threshold with two gates to avoid false positives:

1. **Persistence requirement** (`DISCOVERY_FLOOR_ZERO_RUN_COUNT = 3`): Three consecutive zero-found runs are required to trigger an alert, matching the existing silence detector's window and preventing single-run noise from causing alerts.
2. **Significance requirement** (`DISCOVERY_FLOOR_MIN_PEAK_FOUND = 5`): The source must have reached a peak of at least five found records within the sliding window (7 days) to arm the floor, ensuring alerts only fire for sources that previously carried meaningful volume.

When armed, the floor flips succeeded runs to failed once the zero-run threshold is met, causing the source to re-arm on the next non-zero run. This design avoids alert fatigue while ensuring persistent collapses surface for operator review.

<!-- openwiki: broken internal link [../packages/application/src/observability/discovery-floor.ts] file "../packages/application/src/observability/discovery-floor.ts" does not exist. Fix the href or restore the target, then delete this comment. -->
See [`discovery-floor.ts`](../packages/application/src/observability/discovery-floor.ts) for constants, breach codes, and the zero-found evaluation logic.

## Telemetry

The poller emits telemetry at key lifecycle points to enable external monitoring and debugging. Telemetry callbacks receive structured events with context (source ID, slug, run ID, and phase) and payloads representing job outcomes or runtime metrics. Callback failures are caught and logged to stderr without poller interruption, ensuring observational errors don't disrupt committed work.

Telemetry phases include:
- `connector_progress`: Emitted during connector execution with progress metrics.
- `curation_progress`: Emitted during curation/drain phases.
- `curation_started`: Emitted when curation begins.

<!-- openwiki: broken internal link [../apps/worker/src/poller/telemetry-callback.ts] file "../apps/worker/src/poller/telemetry-callback.ts" does not exist. Fix the href or restore the target, then delete this comment. -->
The telemetry callback mechanism is defined in [`telemetry-callback.ts`](../apps/worker/src/poller/telemetry-callback.ts). Observability adapters integrate by providing a callback function that processes these events (e.g., writing to a monitoring system).

## Alerting

Alerts are triggered by source health signal thresholds, discovery floor breaches, or silence detector violations. Each alert kind corresponds to a specific runbook and is delivered via an alert sink interface.

### Alert Lifecycle

1. **Detection**: Observability components (e.g., bron health evaluator, silence detector, discovery floor) identify a violation and construct an alert record.
2. **Persistence**: Alerts are written to the alert store through the alert writer (`writer.ts`), which ensures deduplication and atomic creation.
3. **Delivery**: The alert sink delivers the notification to external channels (e.g., Slack, email, PagerDuty) with metadata including runbook path, alert stage (opened/escalated), and evidence.
4. **Escalation**: Unacknowledged alerts are re-notified after a configured interval via the escalator.

Alert notifications include:
- `alertId`: Unique identifier.
- `bronId`: Affected source.
- `kind`: Alert type (e.g., `bron.source_health`, `bron.discovery_floor`).
- `message`: Human-readable description.
- `dedupeKey`: Suppresses duplicate alerts for the same issue.
- `createdAt`: Timestamp.
- `runbook`: Path to the operator runbook (e.g., `SOURCE_SILENCE_RUNBOOK_PATH`).
- `stage`: `opened` for initial delivery, `escalated` for re-notifications.
- `evidence`: Structured data supporting the alert (e.g., health signal values, zero-run count).

<!-- openwiki: broken internal link [../packages/application/src/observability/alert-sink.ts] file "../packages/application/src/observability/alert-sink.ts" does not exist. Fix the href or restore the target, then delete this comment. -->
The alert sink abstraction allows pluggable delivery mechanisms. See [`alert-sink.ts`](../packages/application/src/observability/alert-sink.ts) for the notification builder, delivery functions, and failure handling.

### Configuration

Alert thresholds and timing are configured per source or globally:
<!-- openwiki: broken internal link [../packages/application/src/observability/bron-health-thresholds.ts] file "../packages/application/src/observability/bron-health-thresholds.ts" does not exist. Fix the href or restore the target, then delete this comment. -->
- Health signal thresholds (heartbeat, lock age, run/budgets, freshness) are defined in [`bron-health-thresholds.ts`](../packages/application/src/observability/bron-health-thresholds.ts).
<!-- openwiki: broken internal link [../packages/application/src/observability/discovery-floor.ts] file "../packages/application/src/observability/discovery-floor.ts" does not exist. Fix the href or restore the target, then delete this comment. -->
- Discovery floor constants (`DISCOVERY_FLOOR_ZERO_RUN_COUNT`, `DISCOVERY_FLOOR_MIN_PEAK_FOUND`, `DISCOVERY_FLOOR_WINDOW_DAYS`) are in [`discovery-floor.ts`](../packages/application/src/observability/discovery-floor.ts).
<!-- openwiki: broken internal link [../packages/application/src/observability/silence.ts] file "../packages/application/src/observability/silence.ts" does not exist. Fix the href or restore the target, then delete this comment. -->
- Silence detector parameters are in [`silence.ts`](../packages/application/src/observability/silence.ts).

## Related Components

- **Alert writer** (`writer.ts`): Creates alert records and updates bron health status.
- **Bron health aggregator** (`bron-health.ts`): Computes overall source health from signals and updates the bron health store.
- **Cron evaluator** (`cron.ts`): Periodically evaluates health signals, silence, and discovery floor to generate alerts.
- **Escalation handler** (`escalation.ts`): Sends re-notifications for unacknowledged alerts.
- **Silence detector** (`silence.ts`): Identifies abnormally low activity levels complementary to the discovery floor.

## Operation

Operators interact with observability through:
- **Runbooks**: Each alert kind links to a specific runbook (e.g., `SOURCE_SILENCE_RUNBOOK_PATH` for silence alerts).
- **Health dashboards**: Source health signals power visibility into liveness, progress, and freshness.
- **Alert channels**: Configured sinks deliver notifications to paging systems.
- **Threshold tuning**: Adjust thresholds in the configuration files to balance sensitivity and noise.

The system prioritizes actionable signals: a stale heartbeat (`worker_dead`) takes precedence over progress issues, ensuring infrastructure problems are surfaced before pipeline stalls. Discovery floor alerts indicate potential data source regressions requiring selector or sitemap investigation.
