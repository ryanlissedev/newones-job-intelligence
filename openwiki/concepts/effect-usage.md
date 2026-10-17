---
type: concept
title: Effect-TS Usage and Migration
description: How Effect-TS is adopted for managing side effects, retries, and resource safety, with migration status from ADR-0013 and ADR-0014.
tags: [Effect-TS, migration, side-effects, resource-safety]
verified:
  - by: openwiki/0.7.0
    at: 2026-10-17T11:51:19.756Z
sources:
  - id: openwiki-source-580faf66b674f2488d594f59
    resource: repo://packages/env/src/schema-helpers.ts
generated: { by: "openwiki/0.7.0", at: "2026-10-17T11:51:19.756Z" }
---
# Effect-TS Usage and Migration

## Core Patterns

Effect-TS is used to encapsulate side effects (HTTP requests, file system operations, timers) with guaranteed resource safety, retry policies, and structured concurrency. Key patterns include:

- `Effect.success` and `Effect.fail` for creating primitive effects from values or errors.
- `Effect.try` for fallbacks and error handling.
- `Effect.scoped` for acquiring and releasing resources (e.g., database connections, file handles) ensuring cleanup even in case of failure.
- `Effect.gen` for composing effectful logic in a readable, synchronous style while maintaining explicit effect tracking.

These patterns enable deterministic testing, automatic retry with exponential backoff, and prevention of resource leaks.

## Migration Status

<!-- openwiki: broken internal link [../docs/effectts/migration-map.md] file "../docs/effectts/migration-map.md" does not exist. Fix the href or restore the target, then delete this comment. -->
The project-wide adoption of Effect-TS follows the plan documented in the executable migration map ([docs/effectts/migration-map.md](../docs/effectts/migration-map.md)), which tracks progress flow-by-flow. Adoption is performed package-by-package with strict layering to prevent Effect leakage into UI layers.

As of the latest baseline (A0), the status per flow is:

| Flow | Status | Evidence / Notes |
|------|--------|------------------|
| **Ingest** | `opt-in parcialmente` (partially opted-in) | Existing Trigger-entrypoints remain active; cutover requires parity, recovery, and source-bound reconciliation evidence for each connector slice. |
| **Search** | `default` sinds CTP-627 | Native fallback removed; visibility and staleness gates provide evidence. |
| **Chat** | `readiness/partial` | Transport migration tracked via CTP-612; full Effect-chat claim requires end-to-end evidence. |
| **Export** | `contract vastgelegd, cutover open` | Contracts fixed; cutover awaits operator evidence and sandbox validation. |
| **Feedback** | `proposed, niet gebouwd` | No runtime implementation; depends on human evaluation decisions. |
| **Herstel (Recovery)** | `open gate` | Manual/retained path; restore evidence and RPO/RTO targets under discussion. |
| **Toekomstige providers (Future providers)** | `discovery/readiness` | Integration inventory, provider contracts, and tenant consent required before code. |

### Current Executor per Flow

The migration map also documents the active executor for each flow during the transition:

- **Polling + curatie voor geregistreerde JI-bronnen**: Handled by the on-box poller (`apps/worker/src/poller/main.ts`), which owns polling and curation; Trigger is retained only for four specific jobs documented in the on-box poller runbook.
- **Provider-specific slices (Mercell, Indeed, LinkedIn Jobs, Werk.nl)**: Provider/readiness open; these are not yet assigned to a dedicated rollout cohort and cannot be considered greenlit without source-specific evidence.
- **JSON-LD and mixed-adapter cohorts (L3a–L3f)**: Fixture-bewijs op het duurzame pad (fixture evidence on the durable path); operator-canary and releasegate remain open, so no live-runtime claim is made. Rollout proceeds one source at a time via the `POLLER_DURABLE_BRONNEN` flag.
- **Incomplete-field enrichment**: Retained Trigger path; target is a dedicated Effect-job per CTP-626.
- **Recovery/backfill**: Manual/retained path via operator or DB/ops; not part of the ordinary polling flow.
- **Search outbox drain**: On-box executor; Trigger-wrapper remains as interop for other modes.

These details ensure that a flow is only considered Effect-compliant when there is proof of an active Effect-based executor, replay capability, and a working rollback path.

## Integration Boundaries and Guarantees

Effect-TS enforces a strict separation between effectful infrastructure (services, layers, connectors) and pure application logic (UI, presentation layer). Adapters such as React components, Better Auth, Drizzle, and provider SDKs remain narrow translation layers that convert Effect outcomes into UI-friendly forms. This layering prevents accidental leaking of effectful code into UI modules, preserving testability and developer experience.

Resource safety is achieved through `Effect.scoped`, which ties acquisition and release of resources to the lifetime of a scope. Retry policies are defined per effect or per service layer and can be customized with exponential backoff, jitter, and circuit-breaking semantics. Structured concurrency is modeled via child effect supervision, ensuring that failure or interruption of one effect propagates appropriately to its parents.

## Relationship to ADR-0013 and ADR-0014

- **ADR-0013** (Effect-TS Platform Baseline) establishes the foundational platform contracts (services, layers, schema) that all Effect-TS code must adhere to.
- **ADR-0014** (Effect-TS Project-Wide Adoption) decision approves the migration and supersedes legacy runtimes (Trigger.dev, Python/FastAPI/Pydantic, Python/LangGraph) for new first-party backend I/O.

The migration map serves as the executable tracking mechanism for these ADRs, showing which flows have satisfied the baseline and adoption criteria.
