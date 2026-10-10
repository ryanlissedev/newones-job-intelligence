# Performance-evidence uitvoeren

Dit runbook beschrijft hoe Catapulze doorlooptijden verzamelt zonder verschillende machines, cachetoestanden of workloads als één baseline te behandelen. Het evidencecontract staat in [ADR-0001](../adr/ADR-0001-performance-evidence-contract.md), de execution lanes in [ADR-0002](../adr/ADR-0002-execution-lanes-github-crabbox-exedev.md) en het regressiebeleid in [ADR-0003](../adr/ADR-0003-performance-budgets-and-regression-policy.md).

> Er is voor deze configuratie nog geen provider-run uitgevoerd. Een gevalideerde configuratie of dry-run bewijst niet dat exe.dev-authenticatie, provisioning, uitvoering, artifactterugwinning of cleanup werkt. Start geen live run zonder expliciete accounttoegang en een geaccepteerd kostenbudget.

## Cohort eerst vastleggen

Een vergelijking is alleen geldig binnen één homogene cohortfingerprint. Leg vóór de run minimaal vast:

- commit-SHA en clean/dirty-status;
- executor/provider, runner- of machineklasse, OS en architectuur;
- Bun-, Docker- en Postgres-versie;
- workload, dataset-/querysetversie, recordaantal en concurrency;
- `cold` of `warm` en de relevante dependency-, build-, database- en applicatiecache-state.

Een cold run begint zonder herbruikte workloadcache. Een warm run herhaalt dezelfde workload in dezelfde execution lane met de bedoelde caches behouden. Label een onduidelijke tussentoestand niet achteraf als cold of warm. Een andere runnerfamilie, machineklasse, runtime, Postgres-versie, dataset of cachetoestand start een nieuw cohort.

Failed en cancelled runs, timeouts en retries blijven aparte reliability-observaties. Neem ze niet op in succesvolle p50/p95-berekeningen en laat een geslaagde retry de eerdere attempt niet vervangen.

## Lokaal meten

Controleer eerst of geen gelijkwaardige test-, build- of Docker-run actief is. Gebruik maximaal twee testworkers en nooit watch mode.

```sh
PERF_METRICS_DIR=.artifacts/performance/local PERF_RUN_KIND=cold bun run test:timed
PERF_METRICS_DIR=.artifacts/performance/local PERF_RUN_KIND=cold bun run build:timed
PERF_METRICS_DIR=.artifacts/performance/local PERF_RUN_KIND=cold bun run gate:timed
bun scripts/performance/report.ts --output-dir .artifacts/performance/local
```

Herhaal een warm cohort alleen als de caches bewust behouden zijn:

```sh
PERF_METRICS_DIR=.artifacts/performance/local PERF_RUN_KIND=warm bun run test:timed
PERF_METRICS_DIR=.artifacts/performance/local PERF_RUN_KIND=warm bun run build:timed
bun scripts/performance/report.ts --output-dir .artifacts/performance/local
```

Voor database-integratie kan alleen de Postgres-service worden gestart:

```sh
docker compose up -d postgres
```

Wacht op de bestaande healthcheck voordat de workload begint en stop uitsluitend de container die voor deze validatie is gestart:

```sh
docker compose stop postgres
docker compose rm -f postgres
```

Bewaar `.artifacts/performance/` als vluchtig bewijs. Commit meetoutput niet. De gerapporteerde som van commandoduren is compute-/recorded duration en niet automatisch de critical-path wall-clock wanneer fasen overlappen.

## GitHub Actions lezen

De verplichte `CI`-workflow uploadt bij iedere attempt het artifact `ci-performance-<run-id>-<run-attempt>`. Dit bevat de commandometingen voor install, gate en build. De afzonderlijke `CI Metrics`-workflow leest uitsluitend de voltooide run en uploadt `ci-workflow-metrics-<run-id>-<run-attempt>` met workflow-, queue-, job- en stepdoorlooptijden.

Controleer per analyse beide artifacts en rapporteer minimaal:

- queue time en totale wall-clock;
- critical path en totale compute-/jobduur als verschillende grootheden;
- first-failure-tijd, conclusie en attemptnummer;
- install-, gate-, test- en buildfasen voor zover aanwezig;
- commit-SHA, workflow-run-ID en cohortfingerprint.

Tel reruns niet samen alsof ze één succesvolle sample zijn. Laat failed en cancelled attempts zichtbaar. Runs 1–9 zijn measure-only, vanaf 10 homogene successen mag worden gewaarschuwd en pas vanaf 20 homogene successen mag het gatebeleid uit ADR-0003 worden geactiveerd. Ook dan is p95 onder circa 100 observaties instabiel.

## Crabbox valideren zonder provider-run

Gebruik de gepinde Crabbox-versie en checksum uit [ADR-0002](../adr/ADR-0002-execution-lanes-github-crabbox-exedev.md). Crabbox weigert de repository-configured `exeDev.controlHost` bewust wanneer ambient credentials beschikbaar kunnen zijn en de credentialbestemming niet expliciet door de operator is goedgekeurd. Geef daarom voor iedere no-provider-run-opdracht de niet-geheime control host expliciet mee:

```sh
CRABBOX_EXE_DEV_CONTROL_HOST=exe.dev crabbox config show
CRABBOX_EXE_DEV_CONTROL_HOST=exe.dev crabbox job list
CRABBOX_EXE_DEV_CONTROL_HOST=exe.dev crabbox job run --dry-run performance-exe-dev
```

`CRABBOX_EXE_DEV_CONTROL_HOST=exe.dev` is uitsluitend expliciete approval van de bestemming waaraan Crabbox eventuele credentials mag aanbieden; de waarde zelf is geen secret. Deze approval bewijst of verleent geen providerauthenticatie, lease-/VM-provisioning, live run of kostgoedkeuring.

Een dry-run is de standaard stopconditie voor configuratievalidatie. Hij geeft geen toestemming voor kosten en is geen bewijs van een werkende provider-lane. Een plain `crabbox config show` zonder expliciete control-host approval geldt in deze repository niet als verwacht-groene validatie.

De exe.dev-shadow-launcher maakt in de gematerialiseerde workspace een tijdelijke Git-repository aan, omdat Crabbox v0.62.0 met `sync.gitSeed: true` Git-gebaseerd synchroniseert. Voor de eerste `exe-dev-shadow` provideractie controleert de launcher ook de naast de lokale binary opgeslagen provenance met de pinned archive-digest en de gereviewde macOS arm64 binary-digest; ontbrekende of afwijkende provenance stopt die shadow-run. De aparte `performance-exe-dev` job gebruikt direct de remote workspace en heeft daarom geen lokale launcher-provenancecheck; behandel hem als shadow-only totdat de geautoriseerde performance acceptance is uitgevoerd. Die throwaway-commit is uitsluitend voor Crabbox-sync; de evidencefingerprint gebruikt de expliciet overgedragen bronidentiteit.

Op macOS kan een door `uv` beheerde `python3`-shim in sommige sandboxed shells met SIGKILL eindigen wanneer de launcher vanuit een getrapt Bash-script `monotonic_ms` meet. Eindigt de launcher direct met status 137, start hem dan met `PATH=/usr/bin:$PATH` zodat de systeem-Python wordt gebruikt.

Inspecteer in het dry-run-plan expliciet de volgorde warmup → hydrate → run → stop. De jobconfig bewijst daarmee orchestration en de verwachte applicatie-artifacts, maar niet de Crabbox providerfasetiming.

## Crabbox en exe.dev live uitvoeren

Ga alleen verder wanneer alle onderstaande gates aantoonbaar groen zijn:

1. **Auth:** de operator heeft exe.dev-toegang geverifieerd via de normale provider-authenticatie; repositorybestanden bevatten geen credentials.
2. **Kosten:** account, machineklasse, maximaal budget en uitvoeringsdoel zijn vooraf geaccepteerd.
3. **Scope:** commit, workload, runvolgorde en verwachte artifacts zijn vastgelegd; cold/warm mag alleen worden ingevuld als de cachetoestand aantoonbaar is.
4. **Cleanup:** TTL en idle timeout zijn gecontroleerd, `stop: always` staat effectief aan en de operator kan na afloop bevestigen dat runner, lease en machine zijn gestopt.

Een gewone opt-in job mag na deze gates alleen als shadow-run worden gestart:

```sh
crabbox job run performance-exe-dev
```

De huidige job voert twee geordende gate/build-paren uit met `run-kind=unknown` en `sequence-position=1|2`. Daarmee meten we herhaling zonder een onbewezen cachetoestand als cold of warm te labelen. Hij hoort `.artifacts/performance/remote/report.md` plus twee afzonderlijke JUnit-bestanden terug te leveren. Dit zijn onze applicatie-eigen timings en testresultaten. Crabbox v0.62.0 geeft bij `crabbox job run` geen operationele timing-JSON, accepteert daar geen `--timing-json` of `--timing-record` en heeft geen job-schema-pass-through voor die flags. Behandel ontbrekende verplichte artifacts als een mislukte run, niet als ontbrekende performance-data.

De cohortdimensies gebruiken schema versie 2. Ook bij een expliciet machinelabel blijven de geobserveerde CPU-count, geheugencapaciteit en OS-release onderdeel van de fingerprint, zodat hardware- of imagewijzigingen niet stil in hetzelfde cohort belanden.

Voor een geautoriseerde live performance-run moet de operator na inspectie van het dry-run-plan de onderliggende run-stap gecontroleerd uitvoeren met:

- `--timing-json`, dat de finale Crabbox timing-JSON naar stdout van de lokale CLI schrijft;
- `--timing-record <path>`, dat timingrecords append-only naar een lokale JSONL op de operator- of CI-host schrijft.

Neem de exacte provider-, doel- en runargumenten over uit het actuele dry-run-plan en controleer ze tegen `crabbox run --help` en de gepinde documentatie. Dit runbook geeft bewust geen statisch volledig direct-run-commando: die dynamische waarden mogen niet worden gegokt. De direct-run-stap moet binnen dezelfde stop/finally-procedure vallen als de job, inclusief TTL, cleanup bij fouten en teruggelezen eindstatus. Bewaar de JSONL op de operator- of CI-host; verwacht haar niet als bestand op de remote machine.

Zolang hiervoor geen gecontroleerde wrapper bestaat en met timingoutput plus cleanup is bewezen, blijft Crabbox providerfasetiming een open acceptance gap en blijft `crabbox job run` shadow-only.

Controleer na iedere live run in zowel Crabbox/exe.dev als GitHub dat er geen actieve runner, lease, VM of achtergebleven service bestaat. Als cleanup niet aantoonbaar is, start geen volgende run en escaleer naar de accountoperator. Verwijder lokale tijdelijke binaries en downloadmappen die alleen voor validatie zijn gemaakt.

## Search benchmark lane (RJC-344)

`benchmarks/search/run.ts` meet p50/p95/p99 op `SearchAdapter` tegen het queryprofiel in `benchmarks/search/profile.json` (SLO: p95 ≤ 100 ms). Het profiel verwacht een versioned 200k-corpus; die corpus wordt niet gecommit (`fixtures/search/benchmark-corpus.jsonl` staat in `.gitignore`) en moet gegenereerd worden voor gebruik.

### Corpus lokaal genereren

`benchmarks/search/generate-corpus.ts` is een deterministische, geseede synthetic-corpusgenerator (mulberry32 PRNG, geen externe dependency). Gelijke `--seed` en `--documents` geven byte-identieke output — geverifieerd via SHA-256 over twee losse runs.

```sh
bun run bench:generate -- --documents 200000
```

Zonder `--out` schrijft dit naar `fixtures/search/benchmark-corpus.jsonl` (het `corpus.pointer`-pad uit `profile.json`). Elke regel is een `SearchDocument` (zie `packages/search/src/types.ts`), met `laatstGezienOp` als ISO-string in plaats van een `Date` — JSON kent geen Date-type. De vijf queries uit `profile.json` matchen elk ruwweg 1-15% van de documenten; dat wordt bewaakt in `benchmarks/search/generate-corpus.spec.ts` op een 5k-sample via de echte `SearchAdapter`/`InMemorySearchEngine`.

### Tegen lokale compose-Manticore draaien

```sh
docker compose up -d manticore
bun run bench:generate -- --documents 200000
MANTICORE_URL=http://localhost:9308 bun run bench:search
```

`run.ts` leest de corpus via `BENCH_CORPUS` (override) of anders `profile.corpus.pointer`, en valt terug op de bestaande synthetische `seedDocuments`-generator wanneer geen van beide bestanden bestaat (ongewijzigd gedrag voor bestaande lokale/testruns zonder gegenereerde corpus).

**Manticore document-id fix (RJC-356, gevonden tijdens RJC-344).** `ManticoreSearchEngine.upsertDocument` stuurde `SearchDocument.id` (een string — een Postgres UUID in productie) als Manticore's top-level `id`, die verplicht een integer is. Elke write faalde daardoor met `400 Document ids should be integer or array of integers`, geverifieerd met een losstaande `curl` tegen een lokale Manticore-container — ook met een puur numerieke string. Dit was nooit eerder gedekt: alleen mock-based specs (`golden.spec.ts`) raakten dit pad; de enige live-Manticore-integratietest sloeg in de praktijk altijd de vroege-return over omdat `MANTICORE_URL` in `bun run gate`/CI nooit gezet is. Bevestigd via `packages/db/src/aanvraag-stores.ts`'s `PostgresSearchDocumentLoader.loadByAggregateId` (WHERE `aanvraag.id = aggregateId`, retourneert `id: row.id`) dat `document.id === aggregateId` altijd geldt — de outbox-projector's delete-pad (`engine.deleteDocument(event.aggregateId)`, `packages/search/src/projector.ts`) hasht dus al de juiste waarde, geen aparte fix nodig daar. Root-cause fix in `packages/search/src/manticore/`: `id-hash.ts` (nieuw) hasht de originele string-id deterministisch (cyrb53, 53-bit, geen BigInt) naar het numerieke Manticore-document-id; het origineel blijft bewaard als apart attribuut `document_id` (nieuw in `tools/manticore/manticore.conf` en `ManticoreIndexedDocument` — niet `external_id`, dat betekent in dit domein al de bronsysteem-id/bronReferentie) zodat zoekresultaten de echte id teruggeven (`client.ts`'s hit-parsing leest nu `_source.document_id` in plaats van het niet-bestaande `_source.id`). Callers (`apps/worker`, `benchmarks/search/run.ts`) zijn ongewijzigd — zij geven nog steeds de originele string-id door aan `upsertDocument`/`deleteDocument`. Nieuwe live-integratietest: `packages/search/src/manticore/live.spec.ts` (gate: replace → search vindt het origineel via `_source.document_id` → delete → weg), gated op `MANTICORE_URL` net als `golden.spec.ts`, en gewired in `scripts/docker-compose-smoke.sh` zodra die stack Manticore start.

Een schemawijziging op een RT-tabel vergt een herindexering en `manticore_data` is een persisted named volume, dus een bestaand lokaal/CI-volume met de oude `aanvragen`-tabel geeft `unknown column: document_id` op `/replace`. Omdat er nooit succesvol iets op het oude pad is geïndexeerd (RJC-356), is er geen data om te migreren: `tools/manticore/manticore.conf`'s tabelpad is daarom verhoogd naar `aanvragen_v2` (tabelnaam ongewijzigd) — een nieuw pad in plaats van het bestaande pad hergebruiken, data-loss-free. `docker compose down -v` is verboden (BUILD_BRIEF); gebruik in plaats daarvan `docker compose rm -f manticore && docker compose up -d manticore` om het volume naar het nieuwe pad te laten aanmaken.

**Indexeer-concurrency.** `benchmarks/search/run.ts`'s `upsertAll` deed voorheen één ongebonden `Promise.all` over de hele corpus — bij 20.000 documenten resette dit de Manticore-verbinding (`ECONNRESET`), bevestigd lokaal. Nu indexeert het in batches van 100 gelijktijdige `upsertDocument`-calls; dit is de enige wijziging aan `upsertAll`'s gedrag en verandert de externe interface niet.

### CI-lane

`.github/workflows/bench-search.yml` draait op `workflow_dispatch` (input `documents`, default `50000` — zie hieronder) en op `push` naar `main` voor `benchmarks/**`, `packages/search/**`, `packages/domain/**`, `docker-compose.yml`, `tools/manticore/manticore.conf` of de workflow zelf. De job start Manticore 6.3.8 via `docker compose --env-file .env.example up -d --wait manticore` **na** checkout (een `services:`-container start vóór checkout, dus zijn bind-mounted `manticore.conf` zou tegen een lege directory resolven en searchd zou nooit gezond worden — dit is dezelfde `docker-compose.yml`-healthcheck als lokaal), genereert de corpus, en draait de benchmark met `BENCH_ALLOW_FAIL=1` en `PERF_METRICS_DIR=artifacts/perf`. De performance-records landen als artifact `bench-search-<run-id>`.

**Waarom de default 50.000 is, niet 200.000.** Lokaal gemeten tegen compose-Manticore (batches van 100, na de concurrency-fix hierboven): 20.000 documenten indexeren + benchmarken kostte **~306s (5:06) end-to-end**, oftewel ~66,7 docs/sec indexeerdoorvoer — `upsertAll` is één `/replace`-aanroep per document. Geëxtrapoleerd naar 200.000 documenten: ~200.000 / 66,7 ≈ **3.000s (50+ minuten)** — ruim boven de 30 minuten `timeout-minutes` van deze job, zelfs vóór checkout/install/corpus-generatie/Manticore-healthcheck-overhead wordt meegerekend. Bij 50.000 documenten: ~50.000 / 66,7 ≈ 750s (12,5 min), met ruime marge binnen het budget. Drie cohort-dimensies worden meegestuurd, alle via bestaande `buildWorkloadMetadata()`-velden in `packages/performance/src/critical-path/session.ts` (geen nieuwe schemavelden): het corpusaantal (`PERF_ITEM_COUNT` → `item-count` → `cohortDimensions.itemCount`), een sha256-digest van de corpus (`PERF_DATASET_DIGEST` → `dataset-digest` → `cohortDimensions.datasetDigest`; het formaat is `sha256:<hex>`, niet een kale hex-string — de schema-pattern in `scripts/performance/performance-record.schema.json` eist `<algorithm>:<digest>` en `record.ts`'s validator gooit anders een `PerformanceSchemaError`) en de query-concurrency (`PERF_CONCURRENCY` → `concurrency` → `cohortDimensions.concurrency`, uit `profile.concurrency`). Zo tellen een 50k- en een toekomstige 200k-run, of runs met een andere corpusversie of concurrency, nooit als hetzelfde cohort.

**Follow-up (RJC-344): een echte `upsertMany` via Manticore's `/bulk`-endpoint** is de eigenlijke fix om 200k binnen budget te krijgen — één request per batch in plaats van één request per document. Tot die follow-up gebouwd is, blijft de default 50.000; verhoog hem pas na het bouwen van `/bulk`-batching of een hogere jobtimeout, en herhaal dan eerst deze 20k-meting op de CI-runnerklasse zelf, niet alleen lokaal.

Deze lane is bewust **observe-only** en mag niet in een required-check-lijst staan: per ADR-0003 zijn runs 1-9 measure-only en is een tijdgate pas toegestaan vanaf 20 homogene succesvolle runs mét een geaccepteerd absoluut budget in `scripts/performance/performance-budgets.json`. `BENCH_ALLOW_FAIL=1` betekent dat `run.ts`'s eigen exitcode nooit op een SLO-overschrijding faalt, ongeacht de gemeten p95.

**Exacte flip naar enforce**, pas uit te voeren zodra aan beide voorwaarden is voldaan:

1. minstens 20 homogene succesvolle samples uit dezelfde cohortfingerprint (zelfde runner, Manticore-versie, corpusversie, concurrency) zijn verzameld uit de `bench-search-*`-artifacts;
2. een geaccepteerd absoluut budget staat in `scripts/performance/performance-budgets.json`.

Verwijder daarna `BENCH_ALLOW_FAIL: "1"` uit de `env:`-blok van de `Run search benchmark against Manticore`-stap in `.github/workflows/bench-search.yml`, zodat `run.ts` weer op zijn eigen `passed`-berekening faalt (`process.exitCode = 1` wanneer `p95 > sloMaxMs`). Voeg de workflow pas dán toe aan branch-protection required checks.

Officiële referenties:

- [Crabbox run/timing, gepinde release](https://github.com/openclaw/crabbox/blob/v0.62.0/docs/commands/run.md)
- [Crabbox exe.dev-provider](https://github.com/openclaw/crabbox/blob/v0.62.0/docs/providers/exe-dev.md)
