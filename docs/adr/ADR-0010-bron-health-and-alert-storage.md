# ADR-0010 — Dedicated storage voor bron_health en alert versus audit_event

- Status: Accepted
- Datum: 2026-09-04
- Eigenaar: Job Intelligence platform
- Gerelateerd: RJC-409, docs/plans/2026-09-04-feat-bron-dashboard-plan.md §D3, ADR-0001, ADR-0003, ADR-0006, DEC-008

## Besluit

Kies voor **dedicated curatietabellen** (`curated.bron_health` en `curated.alert`) in plaats van hergebruik of uitbreiding van `curated.audit_event` voor operationele brongezondheid en actieve storingswaarschuwingen.

## Context en afwegingen

In unit RJC-409 (D3 van het Bron Dashboard plan) is persistente opslag vereist voor `BronHealthStore` en `AlertStore`. In de afweging stond de keuze tussen hergebruik van de bestaande `curated.audit_event` tabel versus nieuwe, dedicated tabellen in het relationele schema.

De doorslaggevende redenen voor dedicated tabellen zijn:

1. **Onveranderlijkheid (immutability) van de audit trail:**
   `curated.audit_event` is een strikt append-only, onveranderlijk audittraceringslogboek voor compliance, beveiligingsaudits en traceerbaarheid (wie voerde welke handeling uit op welk tijdstip). Alerts hebben daarentegen een operationele levenscyclus met mutabele toestand (`open` -> `acknowledged`, met `acked_at` en `acked_by`). Het muteren van rijen in `audit_event` schendt de fundamentele append-only invariant. Het alternatief van event-sourcing / folding over audit-events zou voor elke dashboard-raadpleging een zware aggregatie vereisen om de actuele alertstatus te reconstrueren.

2. **Semantiek van bron-gezondheid (1:1 operationele snapshot):**
   `curated.bron_health` modelleert de actuele operationele toestand per bron (1:1 gekoppeld aan `curated.bron`). Het ondersteunt directe `onConflictDoUpdate` (upsert) op `bron_id`. In `audit_event` zou elke pipeline-run een nieuw record moeten toevoegen (tabelvervuiling) of zou een dure `DISTINCT ON (bron_id)` query nodig zijn over miljoenen rijen. Met een compacte snapshot-tabel (één rij per bron, circa 12 rijen) is het ophalen van health O(1) en extreem lichtgewicht.

3. **Indexering en deduplicatie van alerts:**
   `curated.alert` vereist idempotente alert-generatie: `findOpenByDedupeKey(dedupeKey)` zoekt open waarschuwingen via een partiële index `ON (dedupe_key) WHERE acked_at IS NULL`. Een gerichte partiële index op een specifieke alerttabel is minimaal in storage en garandeert snelle lookups zonder overhead voor algemene auditevents.

4. **Referentiële integriteit en cascading:**
   Zowel `curated.bron_health` als `curated.alert` hebben expliciete foreign keys naar `curated.bron(id)` met `ON DELETE CASCADE`. Hiermee blijft data-integriteit binnen het relationele model gewaarborgd wanneer een bron wordt verwijderd of opgeschoond.

5. **Performance-budgetten (ADR-0003, D9):**
   Het dashboard stelt scherpe eisen: p95 reactietijd < 1 s en query-budget < 300 ms. Dedicated tabellen maken eenvoudige, geïndexeerde selecties mogelijk die ver binnen het budget blijven, zonder table scans of complexe reconstructies.

## Gevolgen

- Migratie `0016_bron_health_and_alerts.sql` voegt `curated.bron_health` en `curated.alert` toe met passende foreign keys, checks en indices (waaronder `alert_open_idx` met partiële `WHERE acked_at IS NULL`).
- `PostgresBronHealthStore` en `PostgresAlertStore` implementeren de store-interfaces direct tegen de Drizzle-schema-entiteiten.
- `curated.audit_event` behoudt zijn zuivere rol als onveranderlijk auditlogboek.
- `VOLATILE_STORE_ALLOWLIST` in `apps/server/src/assert-production-persistence.ts` verliest `alerts` en `bronHealth`, waardoor `assertProductionPersistence` groen blijft voor alle productiestores behalve het bewust in-memory gehouden `operatorRuns`.
- CTP-653: de escalator houdt zijn escalated-id's proces-lokaal bij; een poller-restart kan een nog-open alert éénmalig opnieuw escaleren. Omdat `curated.alert` naast `acked_at` geen muteerbare kolom heeft, is een persistente `escalated_at` de follow-up als herescalatie bij restart een probleem wordt.
