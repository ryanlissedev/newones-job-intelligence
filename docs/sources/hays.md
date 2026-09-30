# Hays — ingest-recept

Status: **probe afgerond; connector toegevoegd** — adapter-categorie `json-ld`.
Hays publiceert vacatures via een statische zoekpagina en gebruikt zichzelf
als hiring organisation; de eindklant staat niet in de JSON-LD.

## Endpoints

| Doel | URL | Opmerking |
|---|---|---|
| Zoeklijst | `GET https://www.hays.nl/vacatures-zoeken` | Alleen de kale URL; queryvarianten vallen onder robots-disallow. |
| Detail | `https://www.hays.nl/vacature-details/<slug_id>` | Joblinks staan in statische HTML. |
| Sample detail | `https://www.hays.nl/vacature-details/scrum-master-provincie-utrecht_1049921` | JSON-LD bevat `Contracting` en sluitingsdatum. |

## Discovery

De connector matcht `^/vacature-details/[^/?]+$` tegen de pathname. Hays'
eigen href-markup escapt `&` als `&amp;`, volgens de normale
HTML-attribuutregels. De shared extractor decodeert entities vóór
URL-resolutie, zodat ontdekte en opgeslagen URLs exact overeenkomen met de
gerenderde link.

| Hays JSON-LD | Canoniek | Provenance/noot |
|---|---|---|
| `title` | `titel` | Letterlijk overgenomen. |
| `description` | `beschrijving` | Alleen indien gepubliceerd. |
| URL-pad | `bron_referentie` | Trackingquery blijft in `bronUrl`, niet in het pad. |
| `datePosted` | `bronSpecifiek.publicatiedatum` | Publicatiedatum. |
| `employmentType` | `bronSpecifiek.contract_type` | Bijvoorbeeld `Contracting`. |
| `hiringOrganization.name` | `opdrachtgeverNaam` | `Hays`, de broker; client blijft UNKNOWN (CTP-516). |
| `jobLocation.address.addressLocality` | `locatieTekst` | Eerste locatie. |
| `baseSalary` | `tarief` | De samples publiceren `YEAR` of tekstwaarden; de shared mapping neemt die niet als maand/dag/uur-tarief over. |
| `validThrough` | sluitingsmoment | Bronveld wordt als instant verwerkt. |

## Robots, crawl-delay en known hashes

robots.txt noemt `Disallow: /vacatures-zoeken*` en `Crawl-delay: 10` voor
`User-agent: *`. De kale zoeklijst gaf live 200 en echte joblinks; daarom
wordt uitsluitend die URL gebruikt. `seed.crawlDelayMs` is 10000. De sitemap
hash dekt de detailvelden niet; `listingHashCoversDetail` is daarom false.

De fixture → connector → normalise → curate-assertie staat niet in deze
source-test: curatie vereist live Postgres via `createBronRuntimeClient` en
zou bestanden onder `apps/worker`/infra nodig hebben, buiten deze lane.

## Durable cohort (CTP-640, bewezen 2026-09-25)

Hays is bewezen op het duurzame ingestpad (`curated.durable_job` +
`POLLER_DURABLE_BRONNEN`) als onderdeel van de L3d mixed-adapter-cohort
(Harvey Nash + Hays + Need Staffing IT + Onefellow). De connector en
source-definitie zijn ongewijzigd — de migratie is een bewijslast, geen
codewijziging.

**Live-probe 2026-09-25:** `https://www.hays.nl/vacatures-zoeken` → 200,
~268 KB HTML listingpagina (deviates van de committed fixture in omvang —
de fixture blijft de bewijslast, de route is live en in dezelfde vorm).

**Resume-contract** (`packages/connectors/src/json-ld/durable-cohort-l3d.spec.ts`,
5 specs): `discovery.kind` is `listing` — één statische zoekpagina waarvan
de `/vacature-details/…`-links het hele corpus vormen. `discover()` geeft
alles terug met `hasMore: false` en een inert `checkpoint: {}`: géén
pagina-cursor, dus een duurzame herval her-enumereert élke detail-URL en
herfetched élke detailpagina. Exact-één draait op de observatie-replay
sleutel (`scrapeRunId + bronReferentie + contentHash`). `knownHashes`
wordt níét doorgegeven door de hays source-definitie
(`listingHashCoversDetail: false`), dus niets short-circuited de detail
reads. Head-inserts worden door de herval zelf gezien; delistings tellen
via `complete: true` mee in de missed-poll-reconcile.

**Fixture-corpus (eerlijk):** de committed listing-fixture is de echte
HTML-opname — de geparste listing levert 10 `/vacature-details/`-links,
waarvan er 3 een detail-fixture hebben
(`buyer-sports-and-outdoor-amsterdam-1050471`,
`finance-business-partner-rotterdam-1050462`,
`scrum-master-provincie-utrecht-1049921`). De integratiespec scopet de
écht geparse listing op de detail-backed URL's; elke gepersisteerde
payload is een echte opname. Geen opgenomen reject-fixture.

**End-to-end op de echte pipeline** (fixture-client, `ji_test_iso_*`-Postgres,
`apps/worker/src/poller/l3d-cohort.integration.spec.ts` — 5 specs per bron,
groen): offer → `runDurableBronJobConsumer` → `runBronIngestPipeline` →
observaties, `source_record`s, curated `aanvraag`-rijen en `outbox_event`s;
herhaalde run → alles `unchanged`; gewijzigde JobPosting-titel →
`changed`-observatie → nieuwe `aanvraag_versie` + bijgewerkte curated rij;
gefaalde listing-read → run `failed` (`DISCOVER_FAILED`) → herval via
`reopenFailed` (fence +1) → volledige her-enumeratie; abort mid-item →
`failed` (`RAW_STORE_WRITE_FAILED`, CTP-490) → retake exact-één.

**UI-bewijs (geseedde stack):** wegwerp-DB `ji_ctp640_visual_l3d` (door deze
lane aangemaakt), aanvragen gesaaid via het echte duurzame pad met
Manticore-drain (`SEARCH_PROJECTOR=worker`), API `localhost:3000` + web
`localhost:3001` zonder `NEXT_PUBLIC_USE_FIXTURES`: `/jobs` toont de
Bron-facet met alle vier de bronnen incl. tellen. De drie Hays-fixtures
waren bij de seed al `active` (toekomstige sluitingsdatum) — geen repin
nodig; de drie cohort-siblings wel (zie hun secties). Captures:
`/tmp/ctp640-visual/` (H.264 MP4 + PNG, geopend en in frame bevestigd).

**Canary en rollback:** `POLLER_DURABLE_BRONNEN` per bron toevoegen, één
tegelijk, ná de L3a/L3b/L3c-cohorten. Rollback = slug uit de vlag halen;
in-flight jobs lopen leeg, geen dubbele scheduling. `HAYS_LIVE` blijft
uit — dit bewijs is fixture-only. Operator-canary en release-gate blijven
open.
