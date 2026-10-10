# CTP-482 / CTP-486 Slice 4 — Durable CLEARED markers + optional batch apply

Date: 2026-09-08  
Linear: [CTP-486](https://linear.app/rcjt-studio/issue/CTP-486/enrichment-slice-4-durable-cleared-markers-optional-batch-curated) (child of CTP-482)  
Base: `0e916a87` (#216)

## Landed

- Durable `_cleared` markers in `bron_specifiek` after #213 structural strip (CLEARED sentinel string never persists as a commercial value)
- Curate emit/lift paths for locatie/tarief CLEARED so markers survive merge+strip and lift when a later draft sets a real value
- Enrichment planner + incomplete detection honor durable markers (no resurrection of tombstoned commercial fields)
- Optional batch apply: `planCuratedEnrichmentPatchFromStored` + `listPendingCuratedApply` + `enrich-incomplete` flag `applyStoredProposals` (deterministic only; LLM OFF)
- Motian untouched

## Verify

```bash
bun test packages/application/src/enrichment packages/application/src/identity/curate.spec.ts \
  apps/worker/src/tasks/enrich-incomplete.spec.ts
bun run gate
```
