# ADR-0003 — Performancebudgets en regressiebeleid

- Status: Accepted
- Zie ook het [Manticore-latencyrapport van 2026-09-01](../research/manticore-latency-2026-09-01.md): het SearchAdapter p95 ≤ 100 ms-doel is over het 200k-documentenprofiel gedefinieerd, terwijl de tot dusver gemeten ronde 20k documenten betrof — geen productiegeldige claim, wel binnen-SLO op de gemeten schaal.
- Datum: 2026-08-28
- Eigenaar: Job Intelligence platform
- Gerelateerd: ADR-0001, ADR-0002, RJC-320, RJC-331, RJC-344, RJC-415

De geaccepteerde productgrenzen uit D9/RJC-415 staan machineleesbaar in
[`scripts/performance/performance-budgets.json`](../../scripts/performance/performance-budgets.json)
onder `productBudgets`. Dit document blijft de norm voor de
measure/warn/enforce-regels; de JSON is de versieerbare selector en budgetbron.

## Context

Een absoluut tijdsbudget zonder stabiele omgeving creëert een flaky gate. Alleen een relatieve grens mist grote maar al bestaande vertraging. Het beleid combineert daarom absolute veiligheidsgrenzen, vergelijkbare cohorten en herhaalde bevestiging.

## Besluit

Per exacte environment/workload-cohort geldt:

1. runs 1–9 zijn measure-only;
2. vanaf 10 homogene succesvolle runs worden regressies waarschuwingen;
3. vanaf 20 homogene succesvolle runs mag een tijdgate worden geactiveerd;
4. een waarschuwing vereist zowel meer dan 20% als meer dan 15 seconden boven de baseline-mediaan;
5. een harde tijdgate blokkeert alleen wanneer een vooraf vastgelegd absoluut budget wordt overschreden, de meting ook volgens de robuuste baseline van mediaan en median absolute deviation (MAD) een regressie is, en een onafhankelijke bevestigingsbatch dezelfde overschrijding reproduceert;
6. queuevertraging, providerprovisioning en andere niet door de wijziging beïnvloedbare tijd blokkeren nooit een PR;
7. commandofouten, timeouts, correctnessverlies, ontbrekende database-integratietests en ontbrekende verplichte artifacts falen direct;
8. resource- en kostenoverschrijdingen waarschuwen eerst, behalve een vooraf geaccepteerde harde spend/TTL-cap.

Een baseline bevat alleen succesvolle samples met dezelfde cohortfingerprint. De mediaan is het primaire centrum en MAD maakt de vergelijking minder gevoelig voor uitschieters. p95 wordt nooit zonder samplecount getoond en blijft onder circa 100 observaties expliciet een instabiele indicatie, geen zelfstandig gatesignaal. Baselines worden niet automatisch herschreven door een trage run.

Failed en cancelled runs, timeouts en iedere retry/attempt blijven afzonderlijke reliability-observaties. Ze tellen niet mee in de succesvolle tijdverdeling en een retry vervangt of verbergt de eerdere attempt niet.

## Absolute grenzen

- `/bronnen` / `get_dashboard_overview` (RJC-415 / D9): p95 server path < 1 s and each read-model query p95 < 300 ms on a 50k-run / 12-bron / 60-day fixture; ≤4 Postgres round-trips and zero external HTTP in the request path. Evidence: `docs/evidence/rjc-415/`.


- De bestaande GitHub CI-job behoudt voorlopig de harde timeout van 20 minuten.
- Delivery-fasetijden zijn aanvankelijk observe-only; na 10/20 `main`-runs worden de budgets met de gemeten verdeling gekalibreerd.
- De SearchAdapter-doelwaarde van p95 ≤ 100 ms op het versioned 200k-profiel is nog niet een algemene harde gate. De verhouding tot de voorgestelde end-to-end-doelwaarden van 750 ms en 1500 ms blijft pending RJC-320/DEC-004. Dat besluit moet ook queryset, concurrency, warm/cold en de exacte meetgrens vastleggen.
- Loadconcurrency is een apart workloadveld en heft de correctheidslimiet van maximaal twee testworkers niet op.

## Rapportage

Iedere regressiemelding bevat:

- huidige waarde, baseline-mediaan, delta in milliseconden en procenten;
- cohortfingerprint, `n`, cold/warm en cache-state;
- failures/timeouts afzonderlijk;
- cancelled runs en retries/attempts afzonderlijk;
- de langzaamste beïnvloedbare fase;
- link naar SHA, run en evidenceartifact;
- status `observe`, `warn` of `enforce`.

## Gevolgen

- De eerste dagen leveren vooral zichtbaarheid en geen tijdgebaseerde blokkades.
- Een wijziging kan nog steeds direct falen op correctness of ontbrekend bewijs.
- Optimalisaties worden tegen hetzelfde workloadprofiel en dezelfde runnerfamilie beoordeeld.
- Een nieuwe machine, runtime, Postgres-versie of dataset start bewust een nieuw cohort.
