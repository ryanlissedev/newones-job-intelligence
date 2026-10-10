# TenMonks — ingest-recept (geverifieerd 2026-09-16)

Status: **probe afgerond; connector toegevoegd** — adapter-categorie `json-ld`.
TenMonks is een overheid-interim broker. De site gebruikt WordPress/Rank Math;
de detailpagina publiceert een `JobPosting` JSON-LD-node.

## Endpoints

| Doel | URL | Opmerking |
|---|---|---|
| Assignment sitemap | `GET https://tenmonks.nl/assignment-sitemap1.xml` | Voorkeursdiscovery voor v1; bevat de nieuwste circa 200 opdrachten. |
| Assignment sitemap 2 | `GET https://tenmonks.nl/assignment-sitemap2.xml` | Oudere circa 198 opdrachten; follow-up, niet door v1 gecrawld. |
| Sitemap-index | `GET https://tenmonks.nl/sitemap_index.xml` | Door `robots.txt` gelinkt; v1 crawlt bewust alleen assignment-sitemap1. |
| Detail | `GET https://tenmonks.nl/opdrachten/<id>/<slug>/` | Detail-URL met numeriek URL-id en trailing slash. |
| Sample detail | `https://tenmonks.nl/opdrachten/34350/data-analist/` | JSON-LD identifier `JP033750`; dit is niet hetzelfde als URL-id `34350`. |

## Veldmapping → canoniek `aanvraag`

| TenMonks JSON-LD | Canoniek | Provenance/noot |
|---|---|---|
| `title` | `titel` | Samplewaarde `Data Analist`. |
| `description` | `beschrijving` | HTML-escaped opdrachtomschrijving uit de detailpagina. |
| URL-pad | `bron_referentie` | `opdrachten/34350/data-analist`; het URL-id is niet de bronidentifier. |
| `identifier.value` | `bronSpecifiek.identifier.value` | Samplewaarde `JP033750`; de shared normaliser leest dit direct uit JobPosting. |
| `datePosted` | `bronSpecifiek.publicatiedatum` | Samplewaarde `2026-09-15`. |
| `employmentType` | `bronSpecifiek.contract_type` | Samplewaarde `FULL_TIME` (array-vorm wordt als gepubliceerd behouden in de connector). |
| `hiringOrganization.name` | `opdrachtgeverNaam` | Samplewaarde `TenMonks`; geen eindklant afgeleid. |
| `baseSalary` | `tarief` | Shared normaliser promoot EUR/MONTH `3824`–`5624` als maandband. |
| `jobLocation.address.addressLocality` | `locatieTekst` | Samplewaarde `Noord-Holland`. |
| `validThrough` | sluitingsmoment | Samplewaarde `2027-01-01T00:00:00+00:00`. |

## Ingest-patroon

- Lees alleen `assignment-sitemap1.xml` en accepteer detail-URL's in de vorm
  `/opdrachten/<digits>/<slug>/`.
- Respecteer een crawl-delay van 2 seconden.
- Er is in de sample geen betrouwbaar label/value-blok; mapping is JSON-LD-only.
- Het publieke WordPress REST API-pad voor de opdracht-CPT's gaf 404; sitemap
  discovery is daarom de primaire route.

## Robots en voorwaarden

`https://tenmonks.nl/robots.txt` blokkeert `/wp-admin/` en de WPForms-uploadmap,
maar laat de overige site toe en verwijst naar `sitemap_index.xml`. De robotsfile
bevat geen crawlverbod voor opdrachten. De AVG-geautomatiseerde-besluitvorming-
tekst is geen crawlverbod; `voorwaardenStatus` blijft **`te_toetsen`** vóór
activatie.

## Voorwaarden

- robots.txt: tenmonks.nl: HTTP 200, geen Disallow op connectorpaden (/, /opdrachten/34350/data-analist/), geprobed 2026-09-25
- ToS/gebruiksvoorwaarden: zie "Robots en voorwaarden" hierboven
- Besluit: `te_toetsen`
- Besluitnemer en datum: open voor Robbie (geen besluit vastgelegd)

## Overlap, deduplicatie en known hashes

TenMonks is geen **ALIAS** van Opdrachtoverheid; het is een peer broker naast
Bij Oranje, TenTalent, Hero en Pro-Act. Inhoudelijke overlap kan voorkomen,
maar normale identity-deduplicatie moet die behandelen.

`listingHashCoversDetail: false`: de sitemap-hash ziet alleen de URL, terwijl de
relevante JobPosting-velden op de detailpagina staan. Daarom wordt de
known-hash-store niet doorgestuurd (RJC-357/RJC-401).

## Durable JSON-LD-cohort (CTP-641, bewezen 2026-09-25)

TenMonks is bewezen op het duurzame ingestpad (`curated.durable_job` +
`POLLER_DURABLE_BRONNEN`). De connector en source-definitie zijn ongewijzigd —
de migratie is een bewijslast, geen codewijziging.

**Live-probe 2026-09-25:** `https://tenmonks.nl/assignment-sitemap1.xml` → 200,
~30 KB urlset met detaillinks.

**Resume-contract** (`packages/connectors/src/json-ld/durable-cohort-l3e.spec.ts`,
6 specs per bron): discovery is één enkele sitemap-pass — `discover()` geeft het
hele corpus terug met `hasMore: false` en een inerte `checkpoint: {}`. Er is
géén pagina-cursor: een duurzame herval op hetzelfde `scrapeRunId` leest de
sitemap én elke detailpagina opnieuw, en de observatie-replay-sleutel
(`scrapeRunId + bronReferentie + contentHash`) absorbeert al-persisteerde items
— exact-één, geen verlies. Een head-insert wordt al door de herval zelf gezien;
een delisting valt uit de enumeratie en telt via `complete: true` meteen mee in
de missed-poll-reconcile. **Resterende kloof (eerlijk):** alleen een kill tussen
de checkpoint-write (`{}`) en `complete()` laat een `running`-rij mét checkpoint
achter; die herval rapporteert `resumed` en slaat de reconcile voor die run over
— een in dat venster verdwenen record wacht op de volgende verse poll.
Zelfherstellend, nooit stil verouderd.

**Fixture-corpus (eerlijk):** de committed listing-fixture is de echte
sitemap-opname (3 `<loc>`-entries, alle drie geselecteerd), waarvan er 1 een
detail-fixture heeft (`opdrachten/34350/data-analist`). De integratiespec scope
de écht geparse listing op de detail-backed URL's; elke gepersisteerde payload
is een echte opname. Er is géén opgenomen soft-404/reject-fixture voor deze
bron. Heel-corpus-enumeratie is los vastgelegd in de connector-spec.

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
`NEXT_PUBLIC_USE_FIXTURES`: `/jobs` toont in de Bron-facet `TenMonks 1`;
`?source=tenmonks` rendert de 1 rij. Captures: `/tmp/ctp641-visual/` (H.264
MP4 + PNG, geopend en in frame bevestigd). Archief-toggle niet van toepassing
— de seed is actief.

**Canary en rollback:** `POLLER_DURABLE_BRONNEN` per bron toevoegen, één
tegelijk, ná de CTP-630/CTP-637/CTP-638-cohorten. Rollback = slug uit de vlag
halen; in-flight jobs lopen leeg, geen dubbele scheduling (`main.ts` returnt
voor de inline poll). `TENMONKS_LIVE` blijft uit — dit bewijs is fixture-only.
Operator-canary en release-gate blijven open.
