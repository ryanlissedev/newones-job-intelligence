# ADR-0004 — Postgres-omgevingsstrategie

- Status: Accepted voor lokale/CI en productie on-box; het productie-SoR is hersteld via [ADR-0011](ADR-0011-postgres-on-box-trigger-static-ips.md) (2026-09-04). [ADR-0006](ADR-0006-neon-as-system-of-record.md) is voor productie superseded.
- Zie ook [ADR-0007](ADR-0007-search-platform-state-2026-09-01.md) (2026-09-01): de Manticore-helft is nu opgelost door de on-box projector (#96) — de worker hoeft in `onbox`-modus geen Manticore-bereikbaarheid meer te hebben.
- Datum: 2026-08-28
- Eigenaar: Job Intelligence platform
- Gerelateerd: ADR-0001, ADR-0003, ADR-0006, ADR-0011, DEC-005, RJC-321, RJC-347, RJC-418

> **Huidige status (2026-09-04).** [ADR-0011](ADR-0011-postgres-on-box-trigger-static-ips.md) herstelt de dedicated on-box PostgreSQL 16-instance als production system of record en supersedeert [ADR-0006](ADR-0006-neon-as-system-of-record.md) voor productie. De lokale/CI Docker Postgres 16-lane blijft ongewijzigd. Motian/Neon is uitsluitend een read-only backfill/importbron; de Coolify-cutover is uitgevoerd en `/readyz` is groen volgens RJC-418.

## Context

De [BUILD_BRIEF](../BUILD_BRIEF.md) kiest Postgres als source of truth en een read-only import van bestaande data met herkomst. DEC-005/RJC-321 is inmiddels Accepted en Done: Catapulze krijgt een nieuwe dedicated PostgreSQL 16 system of record in Docker/on-box. De huidige Motian/Lovable-Neon-database bevat waardevolle historische data, maar hoort bij het bestaande prototype en zijn eigen schema, performanceprofiel en operationele levenscyclus.

Correctness- en performancetests moeten lokaal en in CI reproduceerbaar zijn zonder provideraccount, netwerkvariatie of wijzigingen aan bestaande data. Productie moet tegelijk aantoonbaar duurzaam, afgeschermd en herstelbaar zijn. Dezelfde Postgres-major maakt gedrag vergelijkbaar, maar een lokale container en de productiehost zijn geen identieke performanceomgevingen.

## Besluit

Lokale ontwikkeling en GitHub CI draaien database-correctness- en performancetests tegen de digest-gepinde PostgreSQL 16 Alpine-image uit [`docker-compose.yml`](../../docker-compose.yml). De Postgres-major, workload, seed, migratieversie, cold/warm-status en execution fingerprint horen bij het [performance-evidencecontract](ADR-0001-performance-evidence-contract.md). Een image-, runtime-, machine- of datasetwijziging start een nieuw performancecohort volgens [ADR-0003](ADR-0003-performance-budgets-and-regression-policy.md).

Productie draait op een dedicated on-box PostgreSQL 16-instance in Docker. De productieconfiguratie voldoet vóór ingebruikname minimaal aan deze eisen:

1. databasebestanden staan op een beschermd extern volume en verdwijnen niet door het vervangen of verwijderen van de container;
2. poort 5432 is uitsluitend bereikbaar via het private applicatienetwerk en wordt niet publiek gepubliceerd;
3. migratie-, runtime-, read-only- en backup/restore-taken gebruiken afzonderlijke least-privilege rollen;
4. write-ahead log (WAL) en backups worden versleuteld off-host bewaard met vastgelegde retentie en bewaakte freshness;
5. restore-drills bewijzen periodiek dat een lege vervangende instance binnen de geaccepteerde RTO kan worden hersteld en dat het dataverlies binnen de RPO blijft;
6. monitoring dekt minimaal beschikbaarheid, disk/volume, CPU/geheugen, connecties/poolwait, locks, querylatency, WAL-groei, backupfreshness en restore-uitkomst;
7. upgrades en migraties hebben een getest rollback- of herstelpad.

De operationele productievoorwaarden en restoregate staan in het [Postgres on-box runbook](../runbooks/postgres-on-box.md).

Test, development en productie houden afzonderlijke instances/databases en afzonderlijke credentials. Productiedata en productiecredentials worden niet gebruikt in lokale of CI-tests. Een lokale testdatabase wordt als vervangbaar behandeld; het productievolume nadrukkelijk niet.

We breiden de huidige Motian/Lovable-Neon-database niet uit met het nieuwe Catapulze-schema en gebruiken haar niet als schrijfdoel. De bestaande data blijft behouden. Invoer naar het nieuwe systeem gebeurt alleen via een read-only export/backfill die:

1. aan de bronzijde geen schema- of datawijzigingen uitvoert;
2. bronrecord-ID, bronsysteem, extract-/ingest-run en mapping-/normalisatieversie behoudt;
3. idempotent en hervatbaar is;
4. aantallen, rejects, duplicates en skips reconcilieert;
5. ongeldige of ambigue records quarantineert in plaats van stil te repareren;
6. rollback mogelijk maakt zonder de brondata te verwijderen.

Er is met dit ADR geen productie-instance, volume, credential, backupbestemming of providerconfiguratie aangemaakt of gewijzigd.

## Representatieve lokale en CI-tests

De Docker Postgres 16-lane is representatief voor portable Postgres-gedrag:

- migraties op een lege database en schema-/constraintvalidatie;
- transacties, idempotentie, unieke sleutels en concurrencyconflicten;
- querycorrectheid van Boolean search, filters, sortering en stabiele paginering;
- aanwezigheid en werking van vereiste extensies, waaronder `pg_trgm`, en de bedoelde FTS-/GIN-indexen;
- queryplannen en latency op een versioned, deterministisch workloadprofiel;
- ingest-, dedupe-, backfill- en reconciliationfixtures zonder productie- of providerdata;
- correctness onder dezelfde maximaal twee testworkers die CI gebruikt.

Deze tests bewijzen geen productielatency, capaciteit, backupkwaliteit of herstelbaarheid. Lokale performance-evidence blijft gebonden aan de Docker-runner, image, dataset, cache-state en resourceklasse. Productie krijgt een eigen cohort en afzonderlijke checks voor echte CPU-, geheugen-, disk-/volume-, netwerk-, connection-pool- en contentionkarakteristieken.

## Productieverificatie vóór en na ingebruikname

De on-box instance vereist afzonderlijk bewijs van:

- private netwerkbereikbaarheid en afwezigheid van een publieke 5432-listener;
- rol- en credentialisolatie plus geweigerde writes voor read-only rollen;
- migratie en rollback op een schone niet-productie-instance;
- backup, WAL-archivering, off-host aanwezigheid en alerts op verouderd bewijs;
- volledige restore naar een lege instance met gemeten RTO en vastgesteld herstelpunt/RPO;
- queryplannen, indexgrootte, vacuum/analyze-state en concurrency op een versioned representatieve dataset;
- disk-, CPU-, geheugen-, lock-, poolwait- en querylatencyalerts;
- read-only Motian/Lovable-Neon-export/backfill met tellingen, rejects, provenance en idempotente hervatting.

Productieresultaten krijgen een eigen machine- en workloadcohort. De SearchAdapter- en end-to-end-budgetten worden pas afgedwongen wanneer RJC-347, het relevante search-SLO-besluit en de samplevoorwaarden uit ADR-0003 zijn gesloten.

## Managed Postgres als escape hatch

Managed Postgres, waaronder Neon, is niet de huidige hostingkeuze. Migratie naar een managed dienst wordt pas een expliciet nieuw besluit wanneer gemeten bewijs toont dat minimaal één grens buiten de single-host envelope valt:

- de vereiste high availability kan niet on-box worden geleverd;
- restore-drills halen de geaccepteerde RTO of RPO niet;
- gemeten CPU-, geheugen-, disk-I/O-, connectie- of lockcontention blijft na gerichte optimalisatie boven het geaccepteerde budget;
- operationele backup-, failover- of beschikbaarheidsverplichtingen zijn niet verantwoord op één host te dragen.

Een eventuele managed migratie vereist een eigen kosten-, beveiligings-, datamigratie-, rollback- en performancebesluit. Een lokaal Docker-resultaat is daarvoor geen zelfstandig bewijs.

## Gevolgen

- De standaard lokale en CI-loop kan volledig zonder live Neon-toegang draaien.
- Productie blijft portable PostgreSQL 16, maar krijgt strengere durability- en operationele eisen dan een vervangbare testcontainer.
- De bestaande Motian/Lovable-data blijft intact en traceerbaar tijdens migratie.
- Een backfill is een gecontroleerde ingeststroom, geen databasekopie die het nieuwe schema dicteert.
- Managed Postgres blijft beschikbaar als onderbouwde uitwijkroute, niet als impliciete huidige architectuur.
