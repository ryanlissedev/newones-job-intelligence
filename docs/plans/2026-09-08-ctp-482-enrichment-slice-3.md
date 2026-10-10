# CTP-482 / CTP-485 Slice 3 — Persist enrichment into curated columns

Date: 2026-09-08  
Linear: [CTP-485](https://linear.app/rcjt-studio/issue/CTP-485/slice-3-persist-high-confidence-enrichment-into-curated-commercial) (child of CTP-482)  
Base: `785e98a3` (#213 CLEARED)

## Landed

- `planCuratedEnrichmentPatch` — deterministic planner that fills only null/unknown commercial gaps
- Respects #213 CLEARED: column tombstones and bron_specifiek CLEARED keys are never resurrected
- `PostgresEnrichmentStore.applyCuratedEnrichmentPatch` writes locatie/tarief/contract/remote columns
- Provenance remains in `aanvraag_enrichment` (source/confidence/rawRefs); overlay/UI aangevuld unchanged
- `enrich-incomplete` persists curated columns when dryRun=false, then thin `aanvraag.enriched` outbox
- LLM residual stays OFF by default; Motian untouched

## Verify

```bash
bun test packages/application/src/enrichment \
  apps/worker/src/tasks/enrich-incomplete.spec.ts
bun run gate
```
