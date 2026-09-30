# ProRail (werkenbijprorail.nl) — ingest-recept

Status: **probe afgerond; connector toegevoegd** — JSON-LD Path A (CTP-580).

## Endpoints

| Doel | URL |
|---|---|
| Listing API | `https://www.prorail.nl/nl/api/v1/vacancysearch?page=1&pageSize=50` |
| Detail | `https://www.werkenbijprorail.nl/vacatures/(functie|verkeersleiding)/<slug>` |

`www.prorail.nl/werken-bij` bestaat niet (404); de corporate site linkt naar `werkenbijprorail.nl`.

## Discovery

De HTML listing heeft geen bruikbare links en de sitemap bevat stale/404
detail-URL's. De connector gebruikt daarom de API als autoritatieve bron en
volgt `hits[].pageUrl`, waarbij `/vacatures/<category>/<slug>` behouden blijft.
De connector leest `pagination.page`, `pagination.pageSize` en
`pagination.totalMatching` en haalt alle benodigde pagina's op met dezelfde
`pageSize`. De API retourneert momenteel alle 16 vacatures op één pagina bij
`pageSize=50`.

## Veldmapping → canoniek `aanvraag`

| JSON-LD | Canoniek | Noot |
|---|---|---|
| `title` | `titel` | Letterlijk. |
| `description` | `beschrijving` | HTML in de bron. |
| `hiringOrganization.name` | `opdrachtgeverNaam` | `ProRail`, directe werkgever. |
| `jobLocation.address.addressLocality` | `locatieTekst` | `addressCountry` is `Nederland`, `addressRegion` is `NL` (omgekeerd op de bron). |
| `datePosted` | `bronSpecifiek.publicatiedatum` | Datum zonder tijd. |
| `validThrough` | `sluitingsdatum` | Aanwezig op beide samples. |
| `employmentType` | `bronSpecifiek.contract_type` | `Full-time` blijft bronwaarde. |
| `workHours` | `bronSpecifiek.uren_per_week` | Vrije tekst (`32-36`), gedeelde parser. |
| `baseSalary` | UNKNOWN | JSON-LD bevat geen `unitText`; tarief is onbetrouwbaar tot CTP-606. |
| `applicationContact` | — | Recruiter-e-mail (PII); niet gebruikt en uit de fixtures verwijderd. |

## Robots, voorwaarden en fixtures

`robots.txt`: alleen `/EPiServer/CMS/` en `/Util/` disallowed; sitemap gepubliceerd. Disclaimer bevat een standaard IE-clausule ("alleen voor niet-commerciële privédoeleinden") zonder expliciete scraping-clausule → `voorwaardenStatus: te_toetsen`, `crawlDelayMs` 2000. `listingHashCoversDetail: false`.

Fixtures: `tools/fixtures/record.ts` met extra strips `prorail-accordion`, `section.vacancy-faq`, `a[href^="mailto:"]` (recruiterblokken); daarna is de sleutel `applicationContact` mechanisch uit de JobPosting-JSON-LD verwijderd.

## Durable JSON-LD-cohort (CTP-641, bewezen 2026-09-25)

ProRail is bewezen op het duurzame ingestpad (`curated.durable_job` +
`POLLER_DURABLE_BRONNEN`). De connector en source-definitie zijn ongewijzigd —
de migratie is een bewijslast, geen codewijziging.

**Live-probe 2026-09-25:** `https://www.prorail.nl/nl/api/v1/vacancysearch?page=1&pageSize=50` → 200,
~27 KB JSON-listing met `hits[].pageUrl`.

**Resume-contract** (`packages/connectors/src/json-ld/durable-cohort-l3e.spec.ts`,
6 specs per bron): discovery is voor de connector één pass — `discover()` geeft
het hele corpus terug met `hasMore: false` en een inerte `checkpoint: {}`.
ProRail's `json-listing`-paginering zit ín `client.fetchListing`
(`discovery.pagination` loopt pagina 2..N af voordat de connector de lijst
ziet), dus er is géén pagina-cursor op run-niveau: een duurzame herval op
hetzelfde `scrapeRunId` leest de listing én elke detailpagina opnieuw, en de
observatie-replay-sleutel (`scrapeRunId + bronReferentie + contentHash`)
absorbeert al-persisteerde items — exact-één, geen verlies. Een head-insert
wordt al door de herval zelf gezien; een delisting valt uit de enumeratie en
telt via `complete: true` meteen mee in de missed-poll-reconcile.
**Resterende kloof (eerlijk):** alleen een kill tussen de checkpoint-write
(`{}`) en `complete()` laat een `running`-rij mét checkpoint achter; die herval
rapporteert `resumed` en slaat de reconcile voor die run over — een in dat
venster verdwenen record wacht op de volgende verse poll. Zelfherstellend,
nooit stil verouderd.

**Fixture-corpus (eerlijk):** de committed listing-fixture is de echte
API-opname (16 `hits` op pagina 1; `totalMatching: 16` → één pagina), waarvan
er 2 een detail-fixture hebben (`woordvoerder`,
`treinverkeersleider-maastricht`). Twee opgenomen detail-fixtures
(`medior-data-engineer`, `sollicitatie`) staan nìet meer in de opgenomen
listing — waaronder de soft-404 (`detail-sollicitatie-soft-404.json`): een
echt opgenomen reject-fixture, maar niet bereikbaar via de gescopede listing,
dus de reject-tak wordt hier niet end-to-end gereden (de connector-spec
dekt `!jobPosting → rejected` generiek af). De integratiespec scope de écht
geparse listing op de detail-backed URL's; elke gepersisteerde payload is een
echte opname. Heel-corpus-enumeratie is los vastgelegd in de connector-spec.

**End-to-end op de echte pipeline** (fixture-client, `ji_test_iso_*`-Postgres,
`apps/worker/src/poller/json-ld-cohort-l3e.integration.spec.ts` — 5 specs per
bron, groen): offer → `runDurableBronJobConsumer` → `runBronIngestPipeline` →
observaties, `source_record`s, curated `aanvraag`-rijen en `outbox_event`s;
herhaalde run → alles `unchanged`, geen duplicaten of extra versies; gewijzigd
detail-payload → `changed`-observatie → nieuwe `aanvraag_versie` + bijgewerkte
curated rij; gefaalde listing-read → run `failed` (`DISCOVER_FAILED`, gezien
aan het begin van de retake) → herval via `reopenFailed` (fence +1) →
volledige her-enumeratie; abort mid-item → `failed`
(`RAW_STORE_WRITE_FAILED` — persistence-abort is nooit benign, CTP-490) →
retake exact-één.

**UI-bewijs (geseedde stack):** wegwerp-DB `ji_ctp641_visual_l3e` (door deze
lane aangemaakt én gedropt), aanvragen gesaaid via het echte duurzame pad met
Manticore-drain (`SEARCH_PROJECTOR=worker`), API :3000 + web :3001 zonder
`NEXT_PUBLIC_USE_FIXTURES`: `/jobs` toont in de Bron-facet `ProRail 2`;
`?source=prorail` rendert de 2 rijen. Captures: `/tmp/ctp641-visual/` (H.264
MP4 + PNG, geopend en in frame bevestigd). Archief-toggle niet van toepassing
— alle seeds zijn actief.

**Canary en rollback:** `POLLER_DURABLE_BRONNEN` per bron toevoegen, één
tegelijk, ná de CTP-630/CTP-637/CTP-638-cohorten. Rollback = slug uit de vlag
halen; in-flight jobs lopen leeg, geen dubbele scheduling (`main.ts` returnt
voor de inline poll). `PRORAIL_LIVE` blijft uit — dit bewijs is fixture-only.
Operator-canary en release-gate blijven open.

## Voorwaarden

- robots.txt: www.prorail.nl: HTTP 200, geen Disallow op connectorpaden (/nl/api/v1/, /, /vacatures/functie/, /vacatures/verkeersleiding/), geprobed 2026-09-25
- ToS/gebruiksvoorwaarden: zie "Robots, voorwaarden en fixtures" hierboven
- Besluit: `te_toetsen`
- Besluitnemer en datum: open voor Robbie (geen besluit vastgelegd)
