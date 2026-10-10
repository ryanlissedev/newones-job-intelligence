# ADR-0001 — Performance-evidencecontract

- Status: Accepted
- Zie ook het [Manticore-latencyrapport van 2026-09-01](../research/manticore-latency-2026-09-01.md): DEC-004's SLO is gedefinieerd over het 200k-documentenprofiel (ADR-0003, JI-016), terwijl de tot dusver gemeten ronde 20k documenten betrof — een 200k-run op productiehardware staat nog open.
- Datum: 2026-08-28
- Eigenaar: Job Intelligence platform
- Gerelateerd: RJC-320, RJC-331, RJC-334, RJC-344

## Context

Snelheid is een producteis, maar de huidige signalen zijn verspreid: GitHub toont job- en stepduur, Bun toont tests, connectoren tellen records en het searchplan noemt percentielen. Zonder één contract kan een groene run geen antwoord geven op vragen als “welke fase werd trager?”, “was dit cold of warm?” en “draaide de database werkelijk?”.

Op 28 augustus 2026 waren slechts twee recente succesvolle waarnemingen uit dezelfde GitHub CI-workflow beschikbaar: één push en één pull request. Ze duurden 171 en 186 seconden van workflow-creatie tot afronding. Daarbinnen kostte `Verify` 85 en 88 seconden en `Build` 54 en 62 seconden. Dit is illustratief bewijs met `n=2`, geen homogeen `main`-cohort, geen baseline en geen budget.

## Besluit

We gebruiken één vendor-neutraal performance-evidencecontract voor lokale runs, GitHub Actions, Crabbox en exe.dev.

Een meting:

1. gebruikt een monotone klok voor duur en ISO 8601 alleen voor correlatie;
2. bindt het resultaat aan commit-SHA, dirty/clean, attempt en een expliciete workload;
3. legt minimaal label, start, einde, duur, exitstatus en veilig geredigeerd commando vast;
4. legt een execution fingerprint vast: executor/provider, runner- of machineklasse, regio indien bekend, OS, architectuur, CPU-aantal, geheugen en runtimeversies;
5. markeert `cold` en `warm`, cache-state, dataset-/querysetdigest, recordaantal en concurrency wanneer die voor de workload gelden;
6. bewaart geen volledige environment, tokens, querytekst, vacature-ID’s, persoonsgegevens of willekeurige URL’s;
7. schrijft machineleesbare JSON en een menselijke Markdown-samenvatting als vluchtig buildartifact, niet als groeiende historie in Git.

Een record is alleen git-bound met een volledige SHA-1 (40 hextekens) of SHA-256 (64 hextekens) én een expliciete dirty/clean-status. Ontbreken beide velden, dan blijft het diagnostisch bewijs; gedeeltelijke of malformed bindingen zijn ongeldig. Rapportages sluiten git-unbound records uit van aantallen, totalen en percentielen en tonen het aantal uitsluitingen apart.

De standaardfasen zijn:

- delivery: queue, provisioning, checkout/sync, runtime-setup, install, services-ready, lint, typecheck, unit, integration, build, e2e, artifact-upload en cleanup;
- search: parser, adapter, engine, facets en serialisatie, plus p50/p95/p99, throughput, fouten en correctness;
- ingest: queuewait, discover, fetch, raw-write, normalisatie, dedupe, commit, outbox en indexprojectie;
- database: connect/poolwait, query/transactie, locks/waits, migratie, backup en restore;
- UI/API: server response, capabilityhandler, zichtbare zoekresultaten en relevante web-vitals;
- resources/kosten: CPU, peak RSS, disk/netwerk, image/starttijd en compute-minuten wanneer aantoonbaar beschikbaar.

## Cohorten en statistiek

Percentielen worden alleen berekend binnen hetzelfde cohort. De sleutel bevat minimaal label, run-kind, executor/provider, runner/machine/regio, OS/architectuur en Bun/toolchain. Een workload voegt dataset/profile/cache-state, Postgres-versie en concurrency toe.

Mislukte runs worden apart geteld. Hun duur wordt niet gemengd met succesvolle p50/p95; anders kan een snelle crash een verbetering lijken. Iedere samenvatting toont `n`, failures en de exacte cohortidentiteit. Cold en warm worden nooit samengevoegd.

## Artifactset

Iedere lane levert waar van toepassing:

- één JSON-record per gemeten fase;
- `report.md`;
- JUnit of een gelijkwaardig testresultaat;
- workload-specifieke benchmark-JSON;
- een manifest met hashes wanneer artifacts extern worden verzameld.

GitHub/Crabbox-providerartifacts zijn de runhistorie. De repository bevat alleen schema’s, profielen, budgets en code om evidence te maken.

## Gevolgen

- Optimalisatie begint bij een gemeten kritieke pad, niet bij intuïtie.
- Runnerwissels starten een nieuw cohort en wissen de oude historie niet.
- Instrumentatie-overhead moet bij een echte productbenchmark apart worden gemeten.
- Correctness, timeouts en ontbrekende verplichte tests blijven belangrijker dan een gunstige tijd.
