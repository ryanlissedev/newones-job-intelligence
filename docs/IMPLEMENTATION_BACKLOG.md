# Implementatiebacklog

De volgorde hieronder maximaliseert een werkende verticale slice. `P0` is nodig voor de eerste gecontroleerde read path en sluit ook de database-production-readiness gate. `P1` voegt de bredere Spot/Spott-export en operationele workflows toe. Taken met `DEC` zijn echte productbesluiten en geen engineering-invulwerk.

## Status per 2026-09-25

- **Gate 0:** deels open. DEC-005 is done (RJC-321/ADR-0011); DEC-001, DEC-002, DEC-003, DEC-007 en DEC-008 zijn open als Linear CTP-317, CTP-318, CTP-319, CTP-323 en CTP-324. DEC-004 en DEC-006: onbekend, niet geverifieerd.
- **Epic A:** grotendeels gedaan. Kernmodel, bronnenregister (49 bronnen), connectorcontract en durable ingest zijn bewezen via cohorten L3a-L3c (PR #429-#431); L3d-L3f liggen open (PR #440, #439, #441). JI-005 (Neon-backfill) en JI-019 (leveranciersspike): onbekend, niet geverifieerd.
- **Epic B:** gedaan voor de read path. Boolean-parser, SearchAdapter op Manticore, jobs-UI en immutable snapshots draaien. JI-016 (200k-benchmarkgate): onbekend, niet geverifieerd.
- **Epic C:** deels gedaan. Het approval/export-contract en de eerste approval/export-UI zijn gesneden (CTP-652); de Spott-export faalt bewust dicht zolang geen productieclient is gekoppeld (DEC-006 open).
- **Epic D:** deels gedaan. Bronhealth, anomaliedetectie en runbooks bestaan; de volle AC-dekking van JI-033 t/m JI-036 en het restore-bewijs uit JI-037 zijn onbekend, niet geverifieerd.
- **Epic E:** deels gedaan. Rollen/capabilities, append-only audit events en repo-secret-scanning bestaan; retentie en verwijdering (JI-043) zijn onbekend, niet geverifieerd.
- **Epic F:** deels gedaan. Connector-contractspecs en fixture-replay draaien; de benchmarkgate en de sandbox-effecttest (JI-016, JI-053) zijn onbekend, niet geverifieerd.

## Gate 0 — besluiten en toegang

| ID | Prio | Taak | Eigenaar | Klaar wanneer |
|---|---:|---|---|---|
| DEC-001 | P0 | Accepteer Ideal State Criteria en donderdagscope | Robbie + Ryan | Read-only slice versus inclusief Spot/Spott staat schriftelijk vast |
| DEC-002 | P0 | Lever definitieve bronmatrix/deep dive | Robbie | Iedere bron heeft URL, land, prioriteit, methode, auth, frequentie, eigenaar en ToS/AVG-status |
| DEC-003 | P0 | Leg schema en deduperegels vast | Samen | Verplichte velden, unknown-gedrag en drie dedupe-niveaus zijn geaccepteerd |
| DEC-004 | P0 | Leg searchcontract en SLO vast | Robbie | Syntax, velden, filters, p95/p99 en benchmarkqueryset zijn testbaar |
| DEC-005 | P0 | Leg Postgres 16 on-box vanaf P0 vast; Motian-Neon blijft alleen read-only importbron | Ryan | **Accepted/Done (RJC-321, 28-08):** besluit, datastroom, backfill, rollback en managed/HA-exitcriteria zijn beschreven |
| DEC-006 | P1 | Bevestig Spot/Spott-product, URL, API en sandbox | Robbie | Officiële docs, sandbox, minimale write scope en unieke ID zijn beschikbaar |
| DEC-007 | P1 | Stel scrape- en hostingbudget vast | Robbie | Maandbudget en alarmeringsdrempels zijn bekend |
| DEC-008 | P0 | Definieer raw-data-minimalisatie en retentie | Robbie + Ryan | PII-scan, toegestane velden, bewaartermijn, verwijderpad en uitzonderingen zijn vóór ingest vastgelegd |

## Epic A — foundation en data

DEC-005 rondt de architectuurkeuze af, niet de implementatie. Provisioning, migraties, operationele validatie en production-readinessbewijs blijven open onder RJC-347.

| ID | Prio | Taak | Afhankelijk | Acceptance criteria |
|---|---:|---|---|---|
| JI-000 | P0 | Audit huidige Motion/Neon-scrapers en search | DEC-002 | Per bestaande bron zijn laatste succes, waarschuwing, volume, parser, index/querypad en besluit `reuse|repair|replace` vastgelegd |
| JI-001 | P0 | Maak repository/runtime-skelet zonder watch mode | DEC-001 | Lint, typecheck en gerichte tests draaien met maximaal 2 workers; processen stoppen na test |
| JI-002 | P0 | Implementeer Postgres-migraties voor het kernmodel | DEC-003, DEC-005 | Alle entiteiten uit de bouwbrief bestaan met FK’s, unique constraints en timestamps; runtime gebruikt `postgres-js` en migreert reproduceerbaar vanaf leeg Postgres 16 |
| JI-003 | P0 | Bouw configureerbaar bronnenregister | DEC-002 | Bronnen hebben `ready|blocked|deferred`, juridische gebruiksstatus en geen secrets in database of repo |
| JI-004 | P0 | Definieer typed connector- en ingestcontract | JI-002, DEC-008 | Connector kan pagineren/checkpointen en levert geminimaliseerde versioned raw records en runmetrics binnen het retentiebeleid |
| JI-005 | P0 | Bouw import/backfill voor bestaande Neon-data | JI-002 | Herhaalbaar, read-only aan bronzijde, aantallen en rejects gereconcilieerd |
| JI-006 | P0 | Implementeer de eerste twee geaccepteerde connectors | JI-000, JI-003, JI-004 | Hoogste-prioriteitsmethoden uit de bronmatrix zijn bewezen; browser wordt alleen gebruikt als een P0-bron dit aantoonbaar vereist |
| JI-007 | P0 | Voeg Indeed toe via geverifieerde toegestane route | DEC-002, JI-004 | Connector werkt end-to-end; anders blijft deze taak een expliciete scopeblocker of wordt Indeed door Robbie uit de slice gehaald |
| JI-008 | P0 | Bouw normalisatie en veldprovenance | JI-002, JI-004 | Minimumvelden, `unknown|invalid`, raw link en normalisatieversie zijn zichtbaar |
| JI-009 | P0 | Bouw idempotentie, cross-source links en lifecycle | JI-008 | Replay maakt geen duplicaten; onzekere links zijn omkeerbaar; stale/closed is traceerbaar |
| JI-018 | P0 | Provision en valideer toegang per P0-bron | DEC-002, JI-040 | Scoped identity/secret is runtime beschikbaar, eigenaar en rotatie zijn vastgelegd en een minimale live read is per bron bewezen |
| JI-019 | P0 | Voer scraperleverancier-spike uit | DEC-002, DEC-007 | Fantastic/Apify/SerpAPI/Bright Data/JobSpy/managed API zijn op actuele prijs, ToS, schema, rate limits en één representatieve sample vergeleken |

## Epic B — search en UI

| ID | Prio | Taak | Afhankelijk | Acceptance criteria |
|---|---:|---|---|---|
| JI-010 | P0 | Bouw geteste Boolean-parser | DEC-004 | `AND/OR/NOT`, haakjes, phrases, precedence en syntaxfouten hebben fixtures |
| JI-011 | P0 | Maak Postgres searchdocument en indexen | JI-002, JI-008 | Titel/description plus filters zijn geïndexeerd; migratie is reproduceerbaar |
| JI-012 | P0 | Implementeer `SearchAdapter` | JI-010, JI-011 | UI kent geen Postgres-details; een toekomstige OpenSearch-adapter past hetzelfde contract |
| JI-013 | P0 | Bouw lean search-UI | JI-012 | Query, filters, count, stabiele paginering, loading/empty/error states werken |
| JI-014 | P0 | Bouw opgeslagen queries en handmatige run | JI-013 | Query bewaart syntax-/schemaversie en is reproduceerbaar |
| JI-015 | P0 | Genereer immutable `QuerySnapshot` | JI-012 | Query, filters, resultaat-ID’s, tijd en indexversie zijn vastgelegd |
| JI-016 | P0 | Maak 200k benchmarkdataset en performancegate | DEC-004, JI-012 | Versioned profiel legt corpus, querymix, concurrency, warm/cold cache, compute, indexstate en vacuumstate vast; p50/p95/p99 zijn reproduceerbaar en falen buiten de geaccepteerde grens |

## Epic C — gecontroleerde Spot/Spott-export

| ID | Prio | Taak | Afhankelijk | Acceptance criteria |
|---|---:|---|---|---|
| JI-020 | P1 | Verifieer Spot/Spott API/MCP met minimale sandbox-read | DEC-006 | Juiste leverancier, officiële contractversie, scopes, rate limits en ID-strategie zijn bewezen |
| JI-021 | P1 | Definieer typed action `export_approved_jobs` | JI-015, JI-020 | Input/output, risk class, budget, allowed target en expected effects zijn versioned |
| JI-022 | P1 | Bouw snapshotgebonden approval | JI-015 | Actor, motivatie, snapshot en expiry zijn verplicht; gewijzigde resultaten vragen nieuwe approval |
| JI-023 | P1 | Bouw idempotente exporter | JI-021, JI-022 | Stabiele `target + canonical_vacancy_id + action_type` veroorzaakt maximaal één create; bestaande crosswalk wordt over snapshots heen geskipt en updates gebruiken een aparte approved action |
| JI-024 | P1 | Bewaar receipts en external-ID-crosswalks | JI-023 | Ieder succes/falen is reconcilieerbaar; geen aanname op HTTP 200 alleen |
| JI-025 | P1 | Voeg bounded retries en dead-letter review toe | JI-023 | Transient versus permanent errors zijn onderscheiden; retry veroorzaakt geen dubbele write |
| JI-026 | P1 | Plan saved searches als voorstellen | JI-014, JI-022 | Iedere run maakt een nieuwe pending `QuerySnapshot`; zonder nieuwe menselijke approval vindt geen export plaats; run- en besluitgeschiedenis is zichtbaar |

## Epic D — observability en operatie

| ID | Prio | Taak | Afhankelijk | Acceptance criteria |
|---|---:|---|---|---|
| JI-030 | P0 | Instrumenteer runs, ingest, normalisatie en search | JI-004, JI-012 | Latency, volumes, rejects, freshness en fouten zijn per bron zichtbaar |
| JI-031 | P0 | Bouw anomaliedetectie voor bronstilte en volumedaling | JI-030 | Event bevat bron, detectietijd, laatste succes, overtreden drempel, evidence, eigenaar, runbook en dedupe key |
| JI-032 | P1 | Bouw brondashboard en alert-routing | JI-030, JI-031 | Testevent bereikt de aangewezen eigenaar één keer, kan worden acknowledged en escaleert na de afgesproken termijn; dashboard toont status en bewijs |
| JI-033 | P1 | Implementeer herstel-escalatieladder | JI-032 | Retry → fallback → diagnose → menselijke review is begrensd en gelogd |
| JI-034 | P1 | Voeg exception-based screenshot/AI-diagnose toe | JI-033 | Alleen anomaly triggert analyse; kostenlimiet, bewijs en menselijke review zijn verplicht |
| JI-035 | P1 | Meet kosten per bron, run en effect | DEC-007, JI-030 | Dag-/maandbudget, waarschuwing en harde grens werken |
| JI-036 | P1 | Maak replay- en backfill-runbooks | JI-005, JI-009 | Een gekozen run/bron kan zonder data- of effectduplicatie worden herhaald |
| JI-037 | P0 | Maak on-box Postgres production-ready | JI-002, DEC-005 | Admin, migrator en app zijn gescheiden en least-privilege; extern beschermd volume en private `5432` zijn afgedwongen; continue WAL gaat off-site; een restore naar een lege geïsoleerde database is bewezen; DB/disk/WAL/back-up/query/resources hebben alerts; Postgres heeft voorrang op Manticore; HA/managed-exitcriteria zijn gemeten en vastgelegd |

## Epic E — security, privacy en evidence

| ID | Prio | Taak | Afhankelijk | Acceptance criteria |
|---|---:|---|---|---|
| JI-040 | P0 | Richt secretmanagement in | JI-001 | Secrets alleen runtime geïnjecteerd; repo/log/UI-scan is schoon |
| JI-041 | P0 | Implementeer minimale rollen | JI-001 | Search, approval, export en beheer hebben aparte capabilities; deny by default |
| JI-042 | P0 | Voeg append-only audit events toe | JI-002 | Belangrijke data-, besluit- en effectevents hebben actor, versie, tijd en correlatie-ID |
| JI-043 | P0 | Implementeer retentie en verwijdering voor vacaturedata | DEC-003, DEC-008 | Raw, index, audit en exports volgen geteste bewaartermijnen; verwijdering/anonimisering werkt door in afgeleide stores met auditbewijs |
| JI-044 | P1 | Maak evidencepack per release | JI-016, JI-024, JI-032, JI-037 | Huidige commit, tests, benchmark, bronreconciliatie, actuele backup-/restore-evidence en end-to-end receipt zijn aanwezig |

## Epic F — verificatie en oplevering

| ID | Prio | Taak | Afhankelijk | Acceptance criteria |
|---|---:|---|---|---|
| JI-050 | P0 | Unit/property-tests voor parser, mappings en identity | JI-008, JI-009, JI-010 | Edge cases en regressies zijn reproduceerbaar gedekt |
| JI-051 | P0 | Contracttests per connector | JI-004 | Saved fixtures detecteren bron- en parserdrift zonder live bron te overbelasten |
| JI-052 | P0 | End-to-end read-path-test | JI-013, JI-030 | Bronfixture → raw → normalisatie → dedupe → query → snapshot slaagt |
| JI-053 | P1 | End-to-end effecttest in Spot/Spott-sandbox | JI-024 | Approval → één write → receipt → veilige replay slaagt |
| JI-054 | P0 | Woensdagreview met evidence | JI-052 | Versie/SHA, omgeving, bronruns, reconciliatie, golden queries, latencyrapport en open Gate-0-besluiten zijn in één reviewpack vastgelegd |
| JI-055 | P0 | Donderdagacceptatie | JI-054 | Iedere geaccepteerde P0-AC heeft pass/fail-evidence; open of gefaalde AC’s blokkeren expliciet de releaseclaim |

## Buiten de eerste slice

### Candidate Intelligence

Voor elk bouwitem eerst: provider/use-case register, DPIA/grondslag, provenance en TTL per assertion, correctie/bezwaar, meaningful human review, fairness-evals, geen auto-reject en geen automatische kandidaatstatuswijziging.

### Company OS

Begin met een typed action catalog, identity, doelbinding, policy, evidence, idempotency, budgets en receipts. MCP of een agentplatform vervangt deze control plane niet.

## Definition of Done

Een backlogitem is pas gereed wanneer code/config, gerichte tests, observability, beveiliging, documentatie en actuele readback zijn geleverd. Een groene losse test, een prototype-UI, een API-callback of een eerder werkende commit is geen eindbewijs.
