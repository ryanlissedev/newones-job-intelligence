# CTP-482 Slice 1 — Automated enrichment scaffolding

Date: 2026-09-07  
Linear: [CTP-482](https://linear.app/rcjt-studio/issue/CTP-482/automated-enrichment-fill-onbekend-fields-from-rawhtml-with-provenance)

## Problem

Curated aanvragen often leave commercial fields (`locatie`, `tarief`, `contract`, `remote`) unknown after normalisation. CTP-429 made the UI honest about those gaps; this slice adds a worker path to fill them from description/raw HTML with provenance instead of inventing values in the UI.

## Slice 1 landed

- `packages/application/src/enrichment/` — types, incomplete detection (zod boundary on `bron_specifiek`), deterministic extractors (`parseTariefFromText`, labeled locatie/contract/remote patterns on collapsed HTML text), LLM hook stub (returns `[]`), orchestration, outbox stub (`aanvraag.enriched`).
- Migration `0020_aanvraag_enrichment.sql` + Drizzle schema + `PostgresEnrichmentStore` (`listIncomplete`, `upsert` on conflict, `listForAanvraag`).
- Worker task `enrich-incomplete` (Trigger `schemaTask`, `dryRun` default `true`, `enableLlmResidual` default `false`, concurrency 1, sequential reduce).
- UI types/helpers: `JobListing.enrichedFields`, `isFieldAangevuld`, detail badge **aangevuld** when confidence ≥ 0.8.
- Script `scripts/inventory-unknown-fields.ts` + SQL notes below.

## Deferred (later slices)

- API live join of enrichment rows into search/detail responses.
- Real outbox insert + projector/Manticore refresh for enriched fields.
- LLM residual extraction behind an explicit flag + structured schema review.
- Residual HTML tag cleanup (separate parallel PR; not blocked here).
- Motian/backfill changes (explicitly untouched).

## Inventory SQL

Run when `DATABASE_URL` is available:

```sql
SELECT
  COUNT(*)::int AS total,
  COUNT(*) FILTER (
    WHERE locatie_tekst IS NULL
      OR trim(locatie_tekst) = ''
      OR locatie_tekst = 'unknown'
  )::int AS locatie_unknown,
  COUNT(*) FILTER (
    WHERE tarief_min IS NULL
      AND tarief_max IS NULL
      AND tarief_eenheid IS NULL
  )::int AS tarief_unknown,
  COUNT(*) FILTER (
    WHERE COALESCE(
      NULLIF(trim(bron_specifiek->>'contracttype'), ''),
      NULLIF(trim(bron_specifiek->>'contract_type'), '')
    ) IS NULL
  )::int AS contract_unknown,
  COUNT(*) FILTER (
    WHERE NULLIF(trim(bron_specifiek->>'werkvorm'), '') IS NULL
  )::int AS remote_unknown
FROM curated.aanvraag;
```

CLI:

```bash
bun scripts/inventory-unknown-fields.ts
```

When no database is reachable, the script exits non-zero and prints the SQL above for manual execution.

## Confidence thresholds

| Threshold | Value | Use |
| --------- | ----- | --- |
| UI badge | 0.8 | Show **aangevuld** in detail |
| Apply/persist | 0.85 | Worker writes enrichment rows |

## Verification

```bash
bun test packages/application/src/enrichment \
  apps/worker/src/tasks/enrich-incomplete.spec.ts \
  apps/web/src/features/job-intelligence/presentation.spec.ts \
  scripts/inventory-unknown-fields.spec.ts \
  packages/db/src/readiness.spec.ts
bun run gate
```

Motian guard:

```bash
git diff origin/main -- apps/worker/src/tasks/backfill-neon-v1.ts packages/application/src/backfill scripts/backfill-neon-v1.ts | wc -l
# expect 0
```
