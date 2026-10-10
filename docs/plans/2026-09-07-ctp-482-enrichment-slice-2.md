# CTP-482 Slice 2 — Live enricher + aangevuld provenance UI

Date: 2026-09-07  
Linear: [CTP-482](https://linear.app/rcjt-studio/issue/CTP-482/automated-enrichment-fill-onbekend-fields-from-rawhtml-with-provenance)  
Base: `c56056f9` (#211)

## Landed

- Worker `enrich-incomplete` persists proposals when `dryRun: false` and inserts a real thin `aanvraag.enriched` outbox event (LLM residual still default OFF).
- API/search live join: `PostgresAanvraagStore` + `PostgresSearchDocumentLoader` overlay `aanvraag_enrichment` rows onto curated facts without overwriting bron-published values.
- Preview/detail responses carry `enrichedFields`; web mapping forwards them to `JobListing`.
- Detail UI shows **aangevuld** badge + tooltip when confidence ≥ 0.8; keeps onbekend below threshold / missing; adds Werkvorm field.

## Deferred

- LLM residual provider (flag remains OFF).
- Motian/backfill (untouched).
- Writing enrichment values back into curated columns (overlay/join only).

## Verify

```bash
bun test packages/application/src/enrichment \
  apps/worker/src/tasks/enrich-incomplete.spec.ts \
  apps/web/src/features/job-intelligence/presentation.spec.ts \
  apps/web/src/features/job-intelligence/detail.spec.ts \
  apps/web/src/features/job-intelligence/job-detail-render.spec.ts
bun run gate
```
