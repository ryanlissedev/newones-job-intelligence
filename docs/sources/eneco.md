# Eneco — ingest-recept

Status: **probe afgerond; connector toegevoegd** — adapter-categorie `json-ld`.

## Endpoints

| Doel | URL | Opmerking |
|---|---|---|
| Sitemap | `GET https://www.werkenbijeneco.nl/sitemap.xml` | 236 URLs; 142 hebben de vacaturevorm. |
| Detail | `https://www.werkenbijeneco.nl/vacatures/<slug>-<nummer>` | JobPosting JSON-LD wanneer de vacature nog open is. |

## Veldmapping en datakwaliteit

| JSON-LD | Canoniek | Provenance/noot |
|---|---|---|
| `title`, `description`, `datePosted` | titel, beschrijving, publicatiedatum | Detailpagina, letterlijk. |
| `hiringOrganization.name` | `opdrachtgeverNaam` | `Eneco`. |
| `jobLocation.address.addressLocality` | `locatieTekst` | Samples: Rotterdam; land is gedeeld `NL`. |
| `baseSalary.value` | `tarief` | Letterlijk `MONTH`; 450–675 is plausibel voor stage, 55000–77000 en 110000–170000 lijken jaarbedragen maar worden niet gecorrigeerd. |
| `validThrough` | `sluitingsdatum` | In de drie samples null/afwezig. |

De sitemap bevat veel inmiddels gesloten vacatures. Die pagina's tonen “Oeps, deze vacature...” en geen JobPosting JSON-LD; dit is een eigenschap van de bron, geen connectorbug. `crawlDelayMs` is 2000 en `voorwaardenStatus` `te_toetsen`.

De sitemap draagt alleen URL/lastmod en geen detailvelden. Daarom is `listingHashCoversDetail: false` en worden known hashes niet doorgestuurd.

## Durable JSON-LD-cohort (CTP-637, bewezen 2026-09-21)

Eneco is bewezen op het duurzame ingestpad (`curated.durable_job` + `POLLER_DURABLE_BRONNEN`). De connector en source-definitie zijn ongewijzigd — de migratie is een bewijslast, geen codewijziging.

**Live-probe 2026-09-21:** `https://www.werkenbijeneco.nl/sitemap.xml` → 200, ~47 KB urlset.

**Resume-contract** (`packages/connectors/src/json-ld/durable-cohort-l3a.spec.ts`, 6 specs per bron): discovery is één enkele sitemap-pass — `discover()` geeft het hele corpus terug met `hasMore: false` en een inerte `checkpoint: {}`. Er is géén pagina-cursor: een duurzame herval op hetzelfde `scrapeRunId` leest de sitemap én elke detailpagina opnieuw, en de observatie-replay-sleutel (`scrapeRunId + bronReferentie + contentHash`) absorbeert al-persisteerde items — exact-één, geen verlies. Een head-insert wordt al door de herval zelf gezien; een delisting valt uit de enumeratie en telt via `complete: true` meteen mee in de missed-poll-reconcile. **Resterende kloof (eerlijk):** alleen een kill tussen de checkpoint-write (`{}`) en `complete()` laat een `running`-rij mét checkpoint achter; die herval rapporteert `resumed` en slaat de reconcile voor die run over — een in dat venster verdwenen record wacht op de volgende verse poll. Zelfherstellend, nooit stil verouderd.

**Fixture-corpus (eerlijk):** de committed listing-fixture is de echte volledige sitemap (142 vacature-URL's), waarvan 3 een detail-fixture hebben. De integratiespec scope de écht geparse listing daarom op de detail-backed URL's; elke gepersisteerde payload is een echte opname. De bekende "Oeps, deze vacature…"-gesloten pagina's gedragen zich op live als `rejected` — het soft-404-equivalent dat bij Heijmans via fixture is bewezen.

**End-to-end op de echte pipeline** (fixture-client, `ji_test_iso_*`-Postgres, `apps/worker/src/poller/json-ld-cohort-l3a.integration.spec.ts` — 5 specs per bron, groen): offer → `runDurableBronJobConsumer` → `runBronIngestPipeline` → observaties, `source_record`s, curated `aanvraag`-rijen en `outbox_event`s; herhaalde run → alles `unchanged`, geen duplicaten; gewijzigd detail-payload → `changed`-observatie → nieuwe `aanvraag_versie` + bijgewerkte curated rij; gefaalde listing-read → `failed` (`DISCOVER_FAILED`) → herval via `reopenFailed` (fence +1) → volledige her-enumeratie; abort mid-item → `failed` (`RAW_STORE_WRITE_FAILED`, CTP-490) → retake exact-één.

**UI-bewijs (geseedde stack):** wegwerp-DB `ji_ctp637_visual_l3a` (aangemaakt én gedropt door deze lane), gesaaid via het echte duurzame pad met Manticore-drain, API :3000 + web :3001 zonder fixtures: `/jobs` toont in de Bron-facet `Eneco 3`; `?source=eneco` rendert 3 rijen. Captures: `/tmp/ctp637-visual/`.

**Canary en rollback:** `POLLER_DURABLE_BRONNEN` per bron toevoegen, één tegelijk, ná de CTP-630-cohort. Rollback = slug uit de vlag halen; in-flight jobs lopen leeg, geen dubbele scheduling. `ENECO_LIVE` blijft uit — fixture-only bewijs. Operator-canary en release-gate blijven open.

## Voorwaarden

- robots.txt: www.werkenbijeneco.nl: HTTP 200, geen Disallow op connectorpaden (/, /vacatures/), geprobed 2026-09-25
- ToS/gebruiksvoorwaarden: niet gevonden
- Besluit: `te_toetsen`
- Besluitnemer en datum: open voor Robbie (geen besluit vastgelegd)
