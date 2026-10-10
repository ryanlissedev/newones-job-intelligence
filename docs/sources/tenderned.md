# TenderNed — ingest-recept (geverifieerd 2026-08-27)

Status: **klaar om te bouwen** — eerste nieuwe bron; rung 1 (officiële API, CC-0, geen login, geen rate-limit waargenomen).

## Endpoints

| Doel | URL | Opmerking |
|---|---|---|
| Listing | `GET https://www.tenderned.nl/papi/tenderned-rs-tns/v2/publicaties` | Spring Page: `content[]`, `totalElements` (145.047 op 27-08), `totalPages`, `size`, `number`, `first`, `last`. Ongeversioneerde pad uit data.overheid.nl 301't hierheen. |
| Detail | `GET …/v2/publicaties/{publicatieId}` | Volledige velden, o.a. `cpvCodes[]`, `nutsCodes[]`, `opdrachtAardCode`, `aankondigingCode`, `numberOfDaysBeforeAanmeldenInschrijven` |
| PDF | `GET …/v2/publicaties/{publicatieId}/pdf` | `application/pdf`, bestandsnaam `TN{kenmerk} - EF29 ….pdf` |
| RSS/Atom | `GET …/papi/tenderned-rs-tns/rss/laatste-publicatie.rss` | Atom; zelfde inhoud als listing-pagina 0 — overbodig als je de API pollt |

## Parameters (empirisch bevestigd)

- `page` (0-based), `size ≤ 100` (101 → 400).
- `publicatieDatumVanaf` / `publicatieDatumTot` = `YYYY-MM-DD`; `publicatieDatumPreset=AF7|AF30`.
- `cpvCodes=72000000-5` — volledige code mét controlecijfer, param herhalen voor meerdere (kommalijst → 400). Hiërarchisch: `72000000-5` → 12.527; `72220000-3` → 543; `79620000-6` → 12.038.
- `typeOpdracht=D` (diensten), `procedure=OPE`, `nutsCodes=NL`, `nationaalOfEuropees=NL|EU`, `sluitingsDatumVanaf`, `search=<tekst>` (+ `sort=relevantie`).
- **Genegeerd** (stil): `sort=publicatieDatum,asc` (altijd nieuwste eerst), `typePublicatie`, `publicatieCode`, `opdrachtAardCode`, `procedureCodes`.
- Combinatie `typeOpdracht=D&cpvCodes=72000000-5&publicatieDatumPreset=AF7` → ~42/week.

## Veldmapping → canoniek `aanvraag`

| TenderNed | Canoniek | Noot |
|---|---|---|
| `kenmerk` | `bron_referentie` (TN-nummer) | één per aanbesteding — **dedupe-sleutel in curated** |
| `publicatieId` | staging-sleutel | één per publicatie; rectificaties/gunningen krijgen nieuwe id onder hetzelfde kenmerk |
| `aanbestedingNaam` | `titel` | |
| `opdrachtgeverNaam` | `opdrachtgever_naam` → `organisatie` | |
| `cpvCodes[{code, omschrijving, isHoofdOpdracht}]` | `bron_specifiek.cpv[]` + `vakgebied_bron` | |
| `nutsCodes[]` | `locatie_tekst` (NUTS-label; CTP-506) | string of `{code,omschrijving}`; meest specifieke code wint |
| `procedureCode.code`, `opdrachtAardCode.code` | `bron_specifiek.procedure`, `.opdracht_aard` | `IDA` = dynamisch aankoopsysteem (enige structurele DAS-marker; alleen in detail); `RAA` = raamovereenkomst |
| `aankondigingCode.code` | `bron_specifiek.aankondiging` | `AAO`/`VAK` open; `AGO`/`VBE` droppen |
| `publicatieDatum` (detail: volledige ISO) | `gepubliceerd_op` | listing heeft alleen datum |
| `numberOfDaysBeforeAanmeldenInschrijven` | `sluitingsdatum` (afgeleid) | **geen expliciet sluitingsdatum-veld**; bij `days > 0`: `observedAt + days`; -1/0 = gesloten; RSS heeft de datum als tekst |
| `opdrachtBeschrijving` (listing, ~1000 tekens) | `beschrijving` (kort) | volledige tekst alleen in de PDF |
| `links.pdf.href` | `aanvraag_bijlage` → object storage | PDF parsen voor geraamde waarde en documentenlijst (niet in JSON) |

## Filter voor inhuur / DAS / IT

`opdrachtAardCode == "IDA"` (DAS) of `RAA` (raamovereenkomst, meeste inhuur) · CPV `79620000-6` (personeelsdiensten) en `72000000-5`-familie (IT) · `aankondigingCode ∈ {AAO, VAK}` · `numberOfDaysBeforeAanmeldenInschrijven > 0` · fallback-regex op naam `DAS|inhuur|detacher`. Minicompetities binnen een DAS worden **niet** gepubliceerd.

## Ingest-patroon

- Poll elke **15 min** met `publicatieDatumVanaf=<gisteren>`, pagina's doorlopen tot een bekende `publicatieId`; nachtelijke `AF7`-rescan vangt teruggedateerde rectificaties.
- Volume: 50–105 publicaties per werkdag, 13–52 in het weekend; detail-call per record voor DAS-detectie (~100/dag).
- Raw-pad: `tenderned/{YYYY}/{MM}/{DD}/{publicatieId}/{listing.json, detail.json, TN{kenmerk}.pdf}`.
- Hash van het ruwe listing-record voor wijzigingsdetectie.
- Beleefdheid: ~2 req/s, beschrijvende User-Agent; geen `Retry-After`/`X-RateLimit-*` gezien (20 parallelle size=100-calls → allemaal 200).
- `robots.txt` (→ `/cms/robots.txt`) blokkeert alleen CMS-admin-paden; `/papi/` niet.

## Licentie en voorwaarden

- data.overheid.nl `package_show` (id `aankondigingen-van-overheidsopdrachten---tenderned`): `license_id` = `creativecommons.org/publicdomain/zero/1.0/deed.nl`, `license_title` **CC-0 (1.0)**. Noot: "deze Webservice [kan] zonder voorafgaande kennisgeving gewijzigd worden"; er is ook een geauthenticeerde XML-API (credentials via functioneelbeheer@tenderned.nl, swagger op `/info/swagger/`).
- Gebruiksvoorwaarden (rev. 19-11-2025): "Alle aankondigingen op het aankondigingenplatform zijn openbaar" en "De openbare gegevens … zijn ook beschikbaar als dataset." §16 legt IE-rechten op databestanden bij de Staat — lichte spanning met CC-0; geen rate-limit- of attributieclausule. Geen blokkade voor activering; noteer in het bronregister als `voorwaarden_status: toegestaan (CC-0, §16 genoteerd)`.

## Voorwaarden

- robots.txt: www.tenderned.nl: HTTP 200, geen Disallow op connectorpaden (/papi/tenderned-rs-tns/v2/), geprobed 2026-09-25
- ToS/gebruiksvoorwaarden: zie "Licentie en voorwaarden" hierboven
- Besluit: `toegestaan`
- Besluitnemer en datum: Ryan (operatorbesluit 2026-09-03, live testimport productie)

## Risico's

1. API "kan zonder kennisgeving wijzigen" → JSON-schema-check in staging (JI-KWA-01).
2. Geen geraamde waarde, geen bijlagenlijst, geen expliciete sluitingsdatum in JSON → PDF-parsing.
3. Geen server-side sortering → backfill per datumvenster, niet per cursor.

Geverifieerd: alle URL's hierboven met HTTP-status; headless Chrome gebruikt voor de UI-call (`/aankondigingen/overzicht` roept `/v2/publicaties?page=0&size=50&publicatieDatumPreset=AF30` aan).

## Contractstart (RJC-432)

De gemodelleerde TenderNed-API publiceert geen contractstart. `publicatieDatum` is uitsluitend publicatiemetadata en blijft als `bron_specifiek.publicatie_datum` bewaard; de canonieke `startDatum` is `UNKNOWN` met provenance `n/a (not published by source)`. Parser `tenderned/v3` (locatie uit NUTS; v2 was de contractstart-correctie) maakt semantische correcties herkenbaar voor gecontroleerde replay. De publicatiedatum mag nooit in de dedupidentiteit terechtkomen.

## Sluitingsdatum (RJC-377 / CTP-531)

TenderNed publiceert geen absolute sluitingsdatum in de gemodelleerde API-velden — alleen `numberOfDaysBeforeAanmeldenInschrijven`, een relatief dagaantal, geen datum (bevestigd tegen `fixtures/connectors/tenderned/detail-pub-001.json`; de RSS-feed zou de datum wél als tekst bevatten, maar dat is een ander discovery-pad, buiten scope van deze normaliser). Voor een positieve, eindige waarde leidt de normaliser de datum eerlijk af als `observedAt + days`, waarbij `observedAt` het fetch-/observatiemoment van de connector is. `publicatieDatum` is uitsluitend publicatiemetadata en mag nooit als anker voor deze berekening worden gebruikt. Bij `days <= 0`, ontbrekende/ongeldige dagen of een ontbrekend/ongeldig observatiemoment blijft `sluitingsdatum` afwezig. `sluitingsdatumPassed` blijft hard `false`; `isTenderNedListingOpen` sluit de aanvraag al via `bronSaysClosed` zodra `aankondigingCode` `AGO`/`VBE` is of het dagaantal op nul staat — dat dagaantal is hier het echte sluitingssignaal.

Bestaande TenderNed-rijen kunnen na deze parserwijziging opnieuw worden afgeleid via ingest replay; dat is de aanbevolen route omdat die de observatie opnieuw door de volledige curate-flow brengt. `tools/backfill/renormalise-from-raw.ts --bron tenderned` geeft bij het re-normaliseren inmiddels `laatst_gezien_op` als `observedAt` mee. De huidige plan/apply-patchset van die CLI bevat nog geen `sluitingsdatum`; gebruik voor het daadwerkelijk bijwerken van dit veld ingest replay, of plan een aparte uitbreiding van die patchset.

## Known-hash short-circuit (RJC-357 / RJC-401)

`listingHashCoversDetail: false` — de fetch haalt een detailrespons op en de normaliser leest daaruit velden die de listing-hash niet ziet: `opdrachtBeschrijving` (→ `beschrijving`), `cpvCodes`, `nutsCodes`, `opdrachtAardCode`, `procedureCode` (→ `bronSpecifiek`) en `opdrachtgeverNaam`. Een detail-wijziging zonder listing-wijziging zou bij een skip bevroren raken. De bron-definitie geeft daarom bewust géén `knownHashes`-store door (afgedwongen in `sources.spec.ts`).

## Durable feed-cohort (CTP-629, bewezen 2026-09-20)

TenderNed is bewezen op het duurzame ingestpad (`curated.durable_job` + `POLLER_DURABLE_BRONNEN`). De connector zelf is ongewijzigd — de migratie is een bewijslast, geen codewijziging.

**Live-probe 2026-09-20** (`/private/tmp/w8-evidence/feed-cohort/`): listing `page=0&size=100` → 200, `totalElements: 23121`, `totalPages: 232`; het pollvenster (`publicatieDatumVanaf/Tot`) → 200, `totalElements: 16`, één pagina, `last: true`; detail `publicaties/440750` → 200 met de detailvelden die de listing-hash niet dekt.

**Resume-contract** (`packages/connectors/src/tenderned/durable-cohort.spec.ts`, 4 specs): `checkpoint.page` is 0-geïndexeerd en wordt na elke pagina opgeslagen als `{page: page+1}`; een duurzame herval leest alleen pagina's ná het checkpoint. Een head-insert tussen twee attempts schuift een al geziene record terug op de cursor-pagina — die wordt opnieuw geobserveerd en geabsorbeerd door de observatie-replay-dedupe (`scrapeRunId + bronReferentie + contentHash`), dus exact-één `source_record`/`aanvraag_observation`. **Resterende kloof (eerlijk):** een tussen de attempts verwijderde record vóór de cursor wordt door de hervatte run overgeslagen; die wordt niet getombstoned (een hervatte run is nooit een complete reconciliatie) en wordt door de volgende verse poll vanaf pagina 0 genezen.

**Completeness/`truncated`:** de connector heeft geen paginalimiet; `hasMore` volgt `!listing.last`. `truncated` blijft dus altijd afwezig — de enige eerlijke waarde onder het RJC-397-contract.

**End-to-end op de echte pipeline** (fixture-client, `ji_test_iso_*`-Postgres): offer → `runDurableBronJobConsumer` → `runBronIngestPipeline` → observaties, `source_record`s en curated `aanvraag`-rijen; gefaalde run → herval op hetzelfde `scrapeRunId` (`reopenFailed`, fence +1) → resume vanaf checkpoint; abort mid-item → run `failed` (persistence-abort is nooit "benign", CTP-490) → retake leest de resterende pagina's alsnog — geen verlies, exact-één. Bewijs: `apps/worker/src/poller/feed-cohort.integration.spec.ts` (6 specs, groen), meegecommit als test-only bewijs — `apps/worker` viel buiten de lane-owned paths, dus deze lane raakt daar bewust geen productiecode, alleen deze spec.

**Canary en rollback:** zet `POLLER_DURABLE_BRONNEN=tenderned` (één bron tegelijk); bekijk `curated.durable_job` + `scrape_run`/`bron_health`. Rollback = slug uit de vlag halen; in-flight jobs lopen leeg, er ontstaat geen dubbele scheduling (`main.ts` returnt voor de inline poll). Geen dataverlies geclaimd buiten het bovenstaande bewijs.
