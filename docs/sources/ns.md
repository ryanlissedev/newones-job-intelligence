# NS (werkenbijns.nl) — ingest-recept

Status: **probe afgerond; connector toegevoegd** — adapter-categorie `json-ld`.

## Endpoints

| Doel | URL | Opmerking |
|---|---|---|
| Listing | `GET https://www.werkenbijns.nl/vacatures` | HTML-listing; 10 vacaturelinks plus listingruis. |
| Detail | `https://www.werkenbijns.nl/vacatures/<slug>` | JobPosting JSON-LD. |

De connector gebruikt `^/vacatures/[a-z0-9]+-[a-z0-9-]+$`, waardoor de bare listing en `/vacatures/favorieten` niet worden ontdekt. Alleen de eerste resultatenpagina wordt gelezen: de HTML bevat een “volgende”-pager, maar Path A heeft geen pagination-follow-mechanisme.

## Veldmapping en datakwaliteit

| JSON-LD | Canoniek | Provenance/noot |
|---|---|---|
| `title`, `description`, `datePosted` | titel, beschrijving, publicatiedatum | Detailpagina. |
| `hiringOrganization.name` | `opdrachtgeverNaam` | `NS`; de organisatie-address is HQ, niet de vacaturelocatie. |
| `jobLocation.address.addressLocality` | `locatieTekst` | Land is gedeeld `NL`. |
| `baseSalary`, `identifier` | tarief, identifier | Ontbreken in alle drie samples; niet geïnterpreteerd. |
| `validThrough` | `sluitingsdatum` | Aanwezig bij IT Lead en SAP RUN manager; conducteur heeft geen waarde. |
| `employmentType` | `bronSpecifiek.contract_type` | Array (`["FULL_TIME"]`), dus de gedeelde string-parser laat dit UNKNOWN. |

`crawlDelayMs` is 2000 en `voorwaardenStatus` `te_toetsen`. Listinglinks bevatten geen detailvelden; daarom is `listingHashCoversDetail: false` en worden known hashes niet doorgestuurd. Tarieven die uit vrije beschrijvingstekst worden herkend blijven bronafhankelijk en zijn niet als JSON-LD `baseSalary` aanwezig. Let op: de gedeelde `parseTariefFromText`-fallback op de IT Lead-sample herkent de solliciteerdeadline "28-09-2026" uit de vrije beschrijvingstekst abusievelijk als een tariefrange (`min: "28"`, `max: "09"`) — dezelfde klasse false positive als CTP-605 (BlueTrail). Dit is gedeelde normaliser-code buiten deze Path-A-recipe; niet hier gefixt, letterlijk vastgelegd in de fixture en de testassertion. Overwegen als vervolgticket.

## Durable JSON-LD-cohort (CTP-637, bewezen 2026-09-21)

NS is bewezen op het duurzame ingestpad (`curated.durable_job` + `POLLER_DURABLE_BRONNEN`). De connector en source-definitie zijn ongewijzigd — de migratie is een bewijslast, geen codewijziging.

**Live-probe 2026-09-21:** `https://www.werkenbijns.nl/vacatures` → 200, ~115 KB HTML-listing; detaillinks via `linkPattern` `^/vacatures/[a-z0-9]+-[a-z0-9-]+$` (`discovery.kind: "listing"`).

**Resume-contract** (`packages/connectors/src/json-ld/durable-cohort-l3a.spec.ts`, 6 specs per bron): discovery is één enkele listing-pass — `discover()` geeft het hele corpus terug met `hasMore: false` en een inerte `checkpoint: {}`. Er is géén pagina-cursor (de "volgende"-pager wordt bewust niet gevolgd — zie Endpoints hierboven): een duurzame herval op hetzelfde `scrapeRunId` leest de listing én elke detailpagina opnieuw, en de observatie-replay-sleutel (`scrapeRunId + bronReferentie + contentHash`) absorbeert al-persisteerde items — exact-één, geen verlies. Een head-insert wordt al door de herval zelf gezien; een delisting valt uit de enumeratie en telt via `complete: true` meteen mee in de missed-poll-reconcile. **Resterende kloof (eerlijk):** alleen een kill tussen de checkpoint-write (`{}`) en `complete()` laat een `running`-rij mét checkpoint achter; die herval rapporteert `resumed` en slaat de reconcile voor die run over — een in dat venster verdwenen record wacht op de volgende verse poll. Zelfherstellend, nooit stil verouderd.

**Fixture-corpus (eerlijk):** de committed listing-fixture is de echte listingpagina (10 vacaturelinks), waarvan 3 een detail-fixture hebben. De integratiespec scope de écht geparse listing daarom op de detail-backed URL's; elke gepersisteerde payload is een echte opname.

**End-to-end op de echte pipeline** (fixture-client, `ji_test_iso_*`-Postgres, `apps/worker/src/poller/json-ld-cohort-l3a.integration.spec.ts` — 5 specs per bron, groen): offer → `runDurableBronJobConsumer` → `runBronIngestPipeline` → observaties, `source_record`s, curated `aanvraag`-rijen en `outbox_event`s; herhaalde run → alles `unchanged`, geen duplicaten; gewijzigd detail-payload → `changed`-observatie → nieuwe `aanvraag_versie` + bijgewerkte curated rij; gefaalde listing-read → `failed` (`DISCOVER_FAILED`) → herval via `reopenFailed` (fence +1) → volledige her-enumeratie; abort mid-item → `failed` (`RAW_STORE_WRITE_FAILED`, CTP-490) → retake exact-één.

**UI-bewijs (geseedde stack):** wegwerp-DB `ji_ctp637_visual_l3a` (aangemaakt én gedropt door deze lane), gesaaid via het echte duurzame pad met Manticore-drain, API :3000 + web :3001 zonder fixtures: `/jobs` toont in de Bron-facet `NS 3`; `?source=ns` rendert 3 rijen. Captures: `/tmp/ctp637-visual/`.

**Canary en rollback:** `POLLER_DURABLE_BRONNEN` per bron toevoegen, één tegelijk, ná de CTP-630-cohort. Rollback = slug uit de vlag halen; in-flight jobs lopen leeg, geen dubbele scheduling. `NS_LIVE` blijft uit — fixture-only bewijs. Operator-canary en release-gate blijven open.

## Voorwaarden

- robots.txt: www.werkenbijns.nl: HTTP 200, geen Disallow op connectorpaden (/, /vacatures/), geprobed 2026-09-25
- ToS/gebruiksvoorwaarden: niet gevonden
- Besluit: `te_toetsen`
- Besluitnemer en datum: open voor Robbie (geen besluit vastgelegd)
