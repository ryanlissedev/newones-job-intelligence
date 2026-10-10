# BAM — ingest-recept

Status: **probe afgerond; connector toegevoegd** — JSON-LD Path A.

## Endpoints

| Doel | URL |
|---|---|
| Sitemap | `https://www.bamcareers.com/nl/nl/sitemap.xml` |
| Detail | `https://www.bamcareers.com/nl/nl/job/<id>/<slug>` |

## Discovery en locale policy

Alleen de NL-locale sitemap wordt gebruikt. De uitsluiting behoudt uitsluitend `/nl/nl/job/<id>/<slug>` en sluit CMS-, blog- en andere locale-paden uit.

## Voorwaarden

- robots.txt: www.bamcareers.com: HTTP 200, geen Disallow op connectorpaden (/nl/nl/, /nl/nl/job/24586/, /nl/nl/job/26209/, /nl/nl/job/26832/), geprobed 2026-09-25
- ToS/gebruiksvoorwaarden: niet gevonden
- Besluit: `te_toetsen`
- Besluitnemer en datum: open voor Robbie (geen besluit vastgelegd)

## Veldmapping → canoniek `aanvraag`

| JSON-LD | Canoniek | Noot |
|---|---|---|
| `title` | `titel` | Letterlijk overgenomen. |
| `description` | `beschrijving` | Gepubliceerde tekst. |
| `hiringOrganization.name` | `opdrachtgeverNaam` | BAM's operationele eenheid is de werkelijke werkgever, geen broker. |
| `jobLocation.address.addressLocality` | `locatieTekst` | Stad uit de PostalAddress. |
| `jobLocation.address.addressCountry` | `locatieLand` | Canoniek NL. |
| `datePosted` | `bronSpecifiek.publicatiedatum` | ISO datum. |
| `identifier` | `bronSpecifiek.identifier` | Unitnaam en numeriek id. |
| `employmentType` | `bronSpecifiek.contract_type` | `OTHER` blijft ongeïnterpreteerd. |
| `workHours` | `bronSpecifiek.uren_per_week` | Shared parser leest dit. |
| `baseSalary`, `validThrough` | UNKNOWN | Niet gepubliceerd; niet afgeleid. |

## Robots, crawl-delay en known hashes

De seed gebruikt 2000 ms. `listingHashCoversDetail: false`: sitemapmetadata dekt de JobPosting-body niet.

## Durable JSON-LD-cohort (CTP-637, bewezen 2026-09-21)

BAM is bewezen op het duurzame ingestpad (`curated.durable_job` + `POLLER_DURABLE_BRONNEN`). De connector en source-definitie zijn ongewijzigd — de migratie is een bewijslast, geen codewijziging.

**Live-probe 2026-09-21:** `https://www.bamcareers.com/nl/nl/sitemap.xml` → 200, ~143 KB urlset.

**Resume-contract** (`packages/connectors/src/json-ld/durable-cohort-l3a.spec.ts`, 6 specs per bron): discovery is één enkele sitemap-pass — `discover()` geeft het hele corpus terug met `hasMore: false` en een inerte `checkpoint: {}`. Er is géén pagina-cursor: een duurzame herval op hetzelfde `scrapeRunId` leest de sitemap én elke detailpagina opnieuw, en de observatie-replay-sleutel (`scrapeRunId + bronReferentie + contentHash`) absorbeert al-persisteerde items — exact-één, geen verlies. Een head-insert wordt al door de herval zelf gezien; een delisting valt uit de enumeratie en telt via `complete: true` meteen mee in de missed-poll-reconcile. **Resterende kloof (eerlijk):** alleen een kill tussen de checkpoint-write (`{}`) en `complete()` laat een `running`-rij mét checkpoint achter; die herval rapporteert `resumed` en slaat de reconcile voor die run over — een in dat venster verdwenen record wacht op de volgende verse poll. Zelfherstellend, nooit stil verouderd.

**Fixture-corpus (eerlijk):** de committed listing-fixture is de echte volledige sitemap (328 NL job-URL's — vastgelegd in `bam.spec.ts`), waarvan 3 een detail-fixture hebben. De integratiespec scope de écht geparse listing daarom op de detail-backed URL's; elke gepersisteerde payload is een echte opname.

**End-to-end op de echte pipeline** (fixture-client, `ji_test_iso_*`-Postgres, `apps/worker/src/poller/json-ld-cohort-l3a.integration.spec.ts` — 5 specs per bron, groen): offer → `runDurableBronJobConsumer` → `runBronIngestPipeline` → observaties, `source_record`s, curated `aanvraag`-rijen en `outbox_event`s; herhaalde run → alles `unchanged`, geen duplicaten of extra versies; gewijzigd detail-payload → `changed`-observatie → nieuwe `aanvraag_versie` + bijgewerkte curated rij; gefaalde listing-read → run `failed` (`DISCOVER_FAILED`) → herval via `reopenFailed` (fence +1) → volledige her-enumeratie; abort mid-item (item 2, na 1 gepersisteerde observatie) → `failed` (`RAW_STORE_WRITE_FAILED`, CTP-490) → retake her-leest alles en de replay-dedupe houdt het exact-één.

**UI-bewijs (geseedde stack):** wegwerp-DB `ji_ctp637_visual_l3a` (door deze lane aangemaakt én gedropt), aanvragen gesaaid via het echte duurzame pad met Manticore-drain, API :3000 + web :3001 zonder fixtures: `/jobs` toont in de Bron-facet `BAM 3`; `?source=bam` rendert 3 rijen. Captures: `/tmp/ctp637-visual/` (H.264 MP4 + PNG, geopend en in frame bevestigd).

**Canary en rollback:** `POLLER_DURABLE_BRONNEN` per bron toevoegen, één tegelijk, ná de CTP-630-cohort. Rollback = slug uit de vlag halen; in-flight jobs lopen leeg, geen dubbele scheduling. `BAM_LIVE` blijft uit — dit bewijs is fixture-only. Operator-canary en release-gate blijven open.
