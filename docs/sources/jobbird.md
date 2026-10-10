# Jobbird — ingest-recept

Status: **probe afgerond; connector toegevoegd** — adapter-categorie `json-ld`.
Deze connector is beperkt tot de freelance/zzp-categorie.

## Endpoints

| Doel | URL | Opmerking |
|---|---|---|
| Freelance listing | `GET https://www.jobbird.com/nl/dienstverband/freelance-zzp` | 15 detail-links op pagina 1 bij capture. |
| Detail | `https://www.jobbird.com/nl/vacature/25796307-freelance-inkoper-sociaal-domein-zzp` | JobPosting JSON-LD. |

## Discovery en ATS

De listing is gevonden via `landing-pages.xml?type=contract-type`, waarin ook
`/nl/dienstverband/interim-opdrachten` en niet-freelancecategorieën staan. De
freelance/zzp-pagina is daarom de relevante, deterministische listing surface.
De connector haalt één pagina: de 15 links op pagina 1 voldoen aan
`/^\/nl\/vacature\/\d+-[^/]+$/u`; pagination naar pagina 2 valt vandaag buiten
scope. De `JobPosting.url`-velden zijn appcast.io-trackingredirects; de
connector-URL blijft leidend voor `bronUrl` en `bronReferentie`.

## Veldmapping → canoniek `aanvraag`

| JobPosting JSON-LD | Canoniek | Provenance/noot |
|---|---|---|
| `title` | `titel` | De drie letterlijke freelance-titels. |
| `description` | `beschrijving` | Gepubliceerde JobPosting-beschrijving. |
| Detail-URL | `bron_referentie` / `bronUrl` | Jobbird-detail-URL, niet de appcast-URL. |
| `identifier.value` | `bronSpecifiek.identifier.value` | `25796307`, `25849909`, `25852520`. |
| `datePosted` | `bronSpecifiek.publicatiedatum` | Gepubliceerde timestamps; respectievelijk 2026-09-09, 2026-09-15 en 2026-09-16. |
| `employmentType` | `bronSpecifiek.contract_type` | `PART_TIME`; gepubliceerd als array. |
| `baseSalary` | `tarief` | Afwezig in alle drie: UNKNOWN, geen parsing gap. |
| `validThrough` | sluitingsmoment/status | Afwezig in alle drie: UNKNOWN, geen parsing gap. |
| `hiringOrganization.name` | `opdrachtgeverNaam` | `Randstad Freelance` is de broker/board, niet de eindklant. `eindklant_naam` blijft UNKNOWN volgens de gedeelde regel; geen expliciet `eindklant`-veld. |
| `jobLocation.address.addressLocality` / `addressRegion` / `addressCountry` | locatie | OIRSCHOT/Oirschot/NL, LEEUWARDEN/Gemeente Leeuwarden/NL, LISSE/Lisse/NL. |

## Robots, crawl delay en known hashes

`robots.txt` disallowt `/nl/job_*`, `/*/api`, `/*/xml` en `/*/ajax/*`, maar niet
de gebruikte categorie-, detail- of sitemappaden. De seed gebruikt 2000 ms.
Fixture-captures: listing `2026-09-16T20:17:34.127Z`, inkoper
`2026-09-16T20:17:51.323Z`, controller `2026-09-16T20:17:59.025Z`, adviseur
`2026-09-16T20:18:07.013Z`.

`listingHashCoversDetail: false`: listingmetadata dekt de detail-JobPosting
niet. Known hashes worden daarom niet doorgegeven.

## Durable JSON-LD-cohort (CTP-641, bewezen 2026-09-25)

Jobbird is bewezen op het duurzame ingestpad (`curated.durable_job` +
`POLLER_DURABLE_BRONNEN`). De connector en source-definitie zijn ongewijzigd —
de migratie is een bewijslast, geen codewijziging.

**Live-probe 2026-09-25:**
`https://www.jobbird.com/nl/dienstverband/freelance-zzp` → 200, ~193 KB
HTML-listingpagina met detaillinks.

**Resume-contract** (`packages/connectors/src/json-ld/durable-cohort-l3e.spec.ts`,
6 specs per bron): discovery is één enkele listing-pass — `discover()` geeft de
hele (bewust één-pagina-)freelance-listing terug met `hasMore: false` en een
inerte `checkpoint: {}`. Er is géén pagina-cursor: een duurzame herval op
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
HTML-opname (15 unieke `/nl/vacature/<id>-…` detaillinks op pagina 1), waarvan
er 3 een detail-fixture hebben
(`25796307-freelance-inkoper-sociaal-domein-zzp`,
`25849909-freelance-business-controller-zzp`,
`25852520-freelance-adviseur-kcc-zzp`). De integratiespec scope de écht geparse
listing op de detail-backed URL's; elke gepersisteerde payload is een echte
opname. Er is géén opgenomen soft-404/reject-fixture voor deze bron.
Heel-corpus-enumeratie is los vastgelegd in de connector-spec.

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
`NEXT_PUBLIC_USE_FIXTURES`: `/jobs` toont in de Bron-facet `Jobbird 3`;
`?source=jobbird` rendert de 3 rijen. Captures: `/tmp/ctp641-visual/` (H.264
MP4 + PNG, geopend en in frame bevestigd). Archief-toggle niet van toepassing
— alle seeds zijn actief.

**Canary en rollback:** `POLLER_DURABLE_BRONNEN` per bron toevoegen, één
tegelijk, ná de CTP-630/CTP-637/CTP-638-cohorten. Rollback = slug uit de vlag
halen; in-flight jobs lopen leeg, geen dubbele scheduling (`main.ts` returnt
voor de inline poll). `JOBBIRD_LIVE` blijft uit — dit bewijs is fixture-only.
Operator-canary en release-gate blijven open.

## Voorwaarden

- robots.txt: www.jobbird.com: HTTP 200, geen Disallow op connectorpaden (/nl/dienstverband/, /nl/vacature/), geprobed 2026-09-25
- ToS/gebruiksvoorwaarden: niet gevonden
- Besluit: `te_toetsen`
- Besluitnemer en datum: open voor Robbie (geen besluit vastgelegd)
