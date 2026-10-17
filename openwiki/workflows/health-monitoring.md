---
type: monitoring
title: Health Monitoring and Source Signals
description: How source connector health, data freshness, and system vitals are monitored and alerted.
tags: [monitoring, observability, health, source, discovery]
verified:
  - by: openwiki/0.7.0
    at: 2026-10-17T11:51:19.756Z
sources:
  - id: openwiki-source-153d6266495cd35fd9026c6a
    resource: repo://packages/application/src/observability/discovery-floor.ts
generated: { by: "openwiki/0.7.0", at: "2026-10-17T11:51:19.756Z" }
---

# Health Monitoring and Source Signals

This page describes how the system monitors the health of source connectors, tracks data freshness, and exposes system vitals for alerting and observability.

## Source Health Signals

The system derives health signals from telemetry collected during connector runs. These signals are pure functions of observed state and do not read the database or clock directly; runtime adapters supply observations.

### Signal Types

Five primary signal types are computed for each source:

- **Process Health**: Based on worker heartbeat freshness.
- **Database Health**: Based on database availability and last probe observation.
- **Advisory Lock Health**: Based on advisory lock state (held, waiting, lost) and observation freshness.
- **Progress Health**: Based on active run phase, milestone progress, and stall detection.
- **Freshness Health**: Based on last fully successful run and current run outcome (complete, incomplete, backlogged, parked, unknown).

Each signal includes a state (`ok`, `progressing`, `stale`, `failed`, `unknown`, `inactive`, `blocked`), a reason code, and an age in milliseconds.

### Aggregate State

The five signals are combined into an aggregate health state:

- **green**: All signals healthy.
- **progressing**: At least one signal is progressing, none are failed.
- **red**: At least one signal is failed.
- **inactive**: Source is administratively inactive.
- **blocked**: Source is blocked (e.g., by rate limiting or publisher restrictions).
- **unknown**: Insufficient data to determine health.

Aggregate reasons provide granular insight into degradation causes (e.g., `progress_stalled`, `freshness_stale`, `worker_dead`).

## Discovery Floor

The discovery floor is a hard guard against silent failures where a source returns zero records without error. It complements the silence detector by triggering on exactly zero found records when the source has previously demonstrated non-zero volume.

### Mechanism

- **Window**: Evaluates the last 7 days of successful runs (`DISCOVERY_FLOOR_WINDOW_DAYS`).
- **Peak Requirement**: Requires a peak of at least 5 records found in-window (`DISCOVERY_FLOOR_MIN_PEAK_FOUND`) to arm the guard, avoiding false positives on low-volume sources.
- **Zero-Run Threshold**: Triggers after 3 consecutive zero-found polls (`DISCOVERY_FLOOR_ZERO_RUN_COUNT`), matching the brondashboard heuristic.
- **Evidence**: On breach, returns the baseline sample count, window days, consecutive zero runs, last non-zero timestamp and count.
- **Alerting**: Emits a `bron.discovery_floor` alert with a localized message indicating discovery has stalled without error.

The floor avoids conflating genuine source exhaustion with selector failures by requiring a prior peak, accepting occasional false alarms on truly expired sources as the cheaper operational trade-off.

## Source Completion Outcomes

Connector run outcomes feed directly into freshness and health signals. The `sourceCompletionOutcome` function maps pipeline results and backlog drainage to one of six outcomes:

- `complete`: No errors, no remaining backlog, no quarantined items.
- `incomplete`: No errors but discovery or curation did not finish (e.g., budget exhausted).
- `backlogged`: Items remain in the backlog after curation.
- `parked`: Errors occurred during discovery or curation.
- `quarantined`: Items were quarantined (e.g., failed validation).
- `unknown`: Completeness could not be determined.

These outcomes inform the `currentRun` freshness signal and are used to determine whether a source is making progress.

## System Vitals

System-wide metrics are exposed via the `/metrics` endpoint for internal dashboards and alerting:

- **Job Latency**: Time from job enqueue to completion.
- **Queue Depth**: Number of pending jobs per priority.
- **Search Latency**: End-to-end latency of search requests.
- **Worker Utilization**: Poller and worker busy/idle ratios.

These vitals help identify systemic issues (e.g., resource saturation, dependency degradation) that may affect multiple sources simultaneously.

## Alerting and Response

Unhealthy source states trigger automated responses and operator notifications:

- Sources with red aggregate state are automatically paused to prevent wasted effort.
- Discovery floor breaches raise immediate alerts requiring manual investigation.
- Signal ages and reasons provide actionable diagnostics for runbooks.
- Metrics anomalies (e.g., rising queue depth, latency spikes) trigger scaling or dependency checks.

Alerts are routed to the on-call team and visualized in the source health dashboard, which aggregates signal states, discovery floor status, and vitals trends.
