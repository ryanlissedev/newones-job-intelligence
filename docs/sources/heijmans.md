# Heijmans — ingest-recept

Status: **probe afgerond; connector toegevoegd** — JSON-LD Path A.

## Endpoints

| Doel | URL |
|---|---|
| Sitemap | `https://www.werkenbijheijmans.nl/sitemap.xml` |
| Detail | `https://www.werkenbijheijmans.nl/vacatures/<slug>-v-<id>` |

## Discovery en uitsluiting

De sitemap bevat CMS-ruis. Alleen de canonieke vorm `/vacatures/<slug>-v-<id>` wordt behouden.

## Veldmapping → canoniek `aanvraag`

| JSON-LD | Canoniek | Noot |
|---|---|---|
| `title` | `titel` | Letterlijk overgenomen. |
| `description` | `beschrijving` | Gepubliceerde tekst. |
| `hiringOrganization.name` | `opdrachtgeverNaam` | Heijmans is de directe werkgever, geen broker. |
| `jobLocation.address.addressLocality` | `locatieTekst` | Stad uit de PostalAddress. |
| `jobLocation.address.addressCountry` | `locatieLand` | Canoniek NL. |
| `datePosted` | `bronSpecifiek.publicatiedatum` | ISO UTC-bronwaarde. |
| `employmentType` | `bronSpecifiek.contract_type` | `FULL_TIME` blijft bronwaarde. |
| `workHours` | `bronSpecifiek.uren_per_week` | Shared parser leest dit. |
| `baseSalary`, `validThrough` | UNKNOWN | Null op de bron. |
| `educationRequirements` | UNKNOWN | Lege array betekent afwezig, niet een opleiding. |

## Soft-404

De sitemap bevat stale URL's die HTTP 200 geven met `Niet gevonden` en zonder JobPosting JSON-LD. De gedeelde connector retourneert dan `rejected` met reden `no JobPosting JSON-LD found on detail page`; de per-source test bewijst dit met een opgenomen soft-404-fixture.

## Robots, crawl-delay en known hashes

De seed gebruikt 2000 ms. `listingHashCoversDetail: false`: sitemapmetadata dekt de JobPosting-body niet.


## Durable JSON-LD-cohort (CTP-637, bewezen 2026-09-21)

Heijmans is bewezen op het duurzame ingestpad (`curated.durable_job` + `POLLER_DURABLE_BRONNEN`). De connector en source-definitie zijn ongewijzigd — de migratie is een bewijslast, geen codewijziging.

**Live-probe 2026-09-21:** `https://www.werkenbijheijmans.nl/sitemap.xml` → 200, ~130 KB urlset.

**Resume-contract** (`packages/connectors/src/json-ld/durable-cohort-l3a.spec.ts`, 6 specs per bron): discovery is één enkele sitemap-pass — `discover()` geeft het hele corpus terug met `hasMore: false` en een inerte `checkpoint: {}`. Er is géén pagina-cursor: een duurzame herval op hetzelfde `scrapeRunId` leest de sitemap én elke detailpagina opnieuw, en de observatie-replay-sleutel (`scrapeRunId + bronReferentie + contentHash`) absorbeert al-persisteerde items — exact-één, geen verlies. Een head-insert wordt al door de herval zelf gezien; een delisting valt uit de enumeratie en telt via `complete: true` meteen mee in de missed-poll-reconcile. **Resterende kloof (eerlijk):** alleen een kill tussen de checkpoint-write (`{}`) en `complete()` laat een `running`-rij mét checkpoint achter; die herval rapporteert `resumed` en slaat de reconcile voor die run over — een in dat venster verdwenen record wacht op de volgende verse poll. Zelfherstellend, nooit stil verouderd.

**Fixture-corpus (eerlijk):** de committed listing-fixture is de echte volledige sitemap (563 vacature-URL's), waarvan 9 een detail-fixture hebben — inclusief de opgenomen soft-404 (`allround-bouwmedewerker-veldhoven-v-014984`), die `rejected` retourneert zonder observatie (zie Soft-404 hierboven). De integratiespec scope de écht geparse listing op de detail-backed URL's; 9 items worden ontdekt, 8 persisteren.

**End-to-end op de echte pipeline** (fixture-client, `ji_test_iso_*`-Postgres, `apps/worker/src/poller/json-ld-cohort-l3a.integration.spec.ts` — 5 specs per bron, groen): offer → `runDurableBronJobConsumer` → `runBronIngestPipeline` → observaties, `source_record`s, curated `aanvraag`-rijen en `outbox_event`s; de soft-404 laat géén rij na (geen observatie, geen source_record, geen aanvraag); herhaalde run → alles `unchanged`, geen duplicaten; gewijzigd detail-payload → `changed`-observatie → nieuwe `aanvraag_versie` + bijgewerkte curated rij; gefaalde listing-read → `failed` (`DISCOVER_FAILED`) → herval via `reopenFailed` (fence +1) → volledige her-enumeratie; abort op detail-call 3 (met hoogstens één reject ervoor, dus ≥1 gepersisteerde observatie) → `failed` (`RAW_STORE_WRITE_FAILED`, CTP-490) → retake absorbeert de gepersisteerde item via de replay-sleutel, exact-één.

**UI-bewijs (geseedde stack):** wegwerp-DB `ji_ctp637_visual_l3a` (aangemaakt én gedropt door deze lane), gesaaid via het echte duurzame pad met Manticore-drain, API :3000 + web :3001 zonder fixtures: `/jobs` toont in de Bron-facet `Heijmans 3`; `?source=heijmans` rendert 3 rijen. Captures: `/tmp/ctp637-visual/`.

**Canary en rollback:** `POLLER_DURABLE_BRONNEN` per bron toevoegen, één tegelijk, ná de CTP-630-cohort. Rollback = slug uit de vlag halen; in-flight jobs lopen leeg, geen dubbele scheduling. `HEIJMANS_LIVE` blijft uit — fixture-only bewijs. Operator-canary en release-gate blijven open.
