# Inhuurdesk (Staffing MS / HeadFirst-familie)

Status: connector en normaliser gebouwd (`packages/connectors/src/inhuurdesk/`, `packages/application/src/normalise/inhuurdesk.ts`), **live-schema hersteld op 2026-09-03**. De eerste fixture (2026-08-28) was nooit een live-capture: hij droeg `aanvraagnummer`/`client`/`description`, terwijl de live API `id`/`clientName`/`content` levert. Een test-import in productie op 2026-09-03 vond 21 records en verwierp ze alle 21. Parser-versie is daarom `inhuurdesk/v2`.

## Endpoint en paginering

`GET https://www.inhuurdesk.nl/wp-json/headfirst-assignments/search?page=N` → `{ total, data[] }`, geen auth, geen anti-bot (probe 2026-08-31, `docs/research/source-verification.md`). Live 2026-09-03: `total: 21`; `page=0` en `page=1` leveren dezelfde 21 records, `page=2` een lege `data` — **1-geïndexeerd**, net als Striive. De connector start daarom op `page=1` (was `0`, wat bij `total > paginagrootte` de eerste pagina dubbel zou lezen) en stopt zodra `page × pageSize ≥ total`; bij één volle pagina is er precies één request. De paginagrootte (≥ 21) is onbevestigd.

De fixture `fixtures/connectors/inhuurdesk/listing-page-0.json` is een gesaneerde live-capture van 2026-09-03 (4 van 21 records, `content` ingekort, ~90 altijd-`null` recruiter/worksite/positionRule-velden samengevouwen tot een representatief paar; veldnamen en -vormen letterlijk).

## Live schema (2026-09-03) → whitelist → normaliser

De ruwe record draagt ~120 velden. Alleen de whitelist (`InhuurdeskAssignment`, DEC-008-projectie `projectInhuurdeskAssignment` in connector.ts) verlaat de connector; recruiter-PII-slots, `clientId`/`portalId`/`recordId`, `brokerUrl` (generieke login-URL, geen detailpagina), `regionLocation` (altijd `[0,0]`), `monthlyRate*`, `rateType` blijven achter.

| Live veld | Type (live) | Whitelist | Normaliser | Bij afwezig |
|---|---|---|---|---|
| `id` | UUID-string | ja | `bronReferentie` (stabiele externe id: de publieke detail-URL is erop gesleuteld; zelfde keuze als Striive) | fetch → `rejected` |
| `referenceCode` (= `recordId`) | `SRQ178204` | ja | `bronSpecifiek.aanvraagnummer` | `null` |
| `title` | string | ja | `titel`; `beschrijving`-fallback | fetch → `rejected` |
| `clientNameSlug`, `titleSlug` | string | ja | `bronUrl` = `https://www.inhuurdesk.nl/aanvragen/<clientNameSlug>/<titleSlug>/<id>` — patroon live bevestigd tegen de hrefs op `/aanvragen/` voor dezelfde records | `UNKNOWN` |
| `clientName` | string | ja | `opdrachtgeverNaam` | `UNKNOWN` |
| `content` | HTML | ja | `beschrijving` (entity-decode via `decodeHtmlEntities`, dan `stripHtml`); tekst-parse voor `tarief` | `titel` |
| `location` | string (vrije tekst, bv. "Gemeentehuis") | ja | `locatieTekst`; `locatieLand` hard `NL` | `UNKNOWN` |
| `startDate` | naive ISO datetime | ja | `startDatum` (`YYYY-MM-DD`) | `UNKNOWN` |
| `endDate` | naive ISO datetime | ja | `bronSpecifiek.eind_datum` | `null` |
| `closingDateClient` | naive ISO datetime (Europe/Amsterdam, mét tijd) | ja | `sluitingsdatum` + `sluitingsdatumPassed` → lifecycle `closed` | geen sluitingsdatum, lifecycle `active` |
| `closingDateInvoice` | naive ISO datetime | ja | `bronSpecifiek.supplier_deadline` | `null` |
| `hoursPerWeekMin/Max` | number | ja | `bronSpecifiek.uren_min/uren_max` | `null` |
| `hourlyRateMin/Max`, `hasMaxRate` | number / boolean | ja | `tarief.min/max` in EUR per uur **alleen bij `> 0`**; live 2026-09-03 stonden alle 21 op `0`/`false` (= niet gepubliceerd), dan valt de normaliser terug op de tekst-parse van `content` ("max tarief €110 per uur") | `UNKNOWN` |
| `publishedDate`, `segmentName` | string | ja | `bronSpecifiek.gepubliceerd_op`, `bronSpecifiek.segment` | `null` |

Live-bewijs 2026-09-03 na de fix (connector + normaliser vanuit dit worktree): found 21 / new 21 / rejected 0 / error 0; 21 van 21 drafts valideren; 21 met `sluitingsdatum`, 21 met `bronUrl`, 7 met een tarief uit de tekst-parse.

## Sluitingsdatum (correctie op RJC-377)

De RJC-377-notitie "Inhuurdesk publiceert geen sluitingsdatum" beschreef de niet-live fixture. Live draagt elk record `closingDateClient` (client-deadline, mét tijdcomponent) en `closingDateInvoice` (leveranciersdeadline). `closingDateClient` is de canonieke `sluitingsdatum`, vergeleken op het volledige instant (RJC-376, zelfde pad als Striive). Er is geen per-record "gesloten"-vlag, dus `bronSaysClosed` blijft hard `false`; verdwijnen uit de listing loopt via het generieke `missedPolls`-pad (`docs/sources/README.md`).

## CTP-520 veldmapping-fixes en blokkers buiten deze laag

- **F04 provincie (fixed)** — `bronSpecifiek.provincie` via `findProvincieInText(assignment.location)`. De meest recente live capture (2026-09-15, `GET /wp-json/headfirst-assignments/search?page=1`) telde **18** records (niet 21 — drie van de op 2026-09-03 geziene aanvragen zijn inmiddels gesloten/verdwenen); de meeste `location`-waarden zijn een kale stad/site-naam ("Amsterdam Westpoort", "Schiedam", "Doorn") zonder provincie, dus `null` in de praktijk. Uitzondering: 5 van de 18 records dragen letterlijk `"Utrecht"` als locatie — dat resolvet via de gedeelde helper wél naar de provincie "Utrecht" (de stads- en provincienaam zijn identiek), wat mogelijk optimistisch is voor een puur stadsniveau-locatie; `provincie.ts` valt buiten de scope van deze lane (import-only), dus dit is hier alleen gedocumenteerd, niet aangepast.
- **F15 skills, F14 niveau — ABSENT_SRC (bevestigd met een live capture 2026-09-15, niet fixable).** Een polite read-only capture-paar via `ssh <exe-dev-host>`: de listing-endpoint (`GET /wp-json/headfirst-assignments/search?page=1`, 18 records) en de detail-pagina voor het eerste record (`/aanvragen/umc-utrecht/dialyseverpleegkundige-aa---vv/bfec2eea-…`, gesaneerd bewaard als `fixtures/connectors/inhuurdesk/detail-bfec2eea-a5d6-4431-a4fb-b4c1fe7a57d4.json` (heropgenomen 2026-09-16 met `bun tools/fixtures/record.ts`, envelope met echte `capturedAt`) — geen recruiter-PII aangetroffen op de pagina zelf, alleen het generieke Inhuurdesk-kantooradres/telefoonnummer in de footer). Bevindingen: `tags`/`tagNames`/`requirements` zijn `""`/`[]` op **alle 18** live records (was al zo op de 4 eerder gecapturede) — het API-schema draagt deze velden, maar deze bron/tenant vult ze nooit. Er bestaat geen apart detail-JSON-endpoint; de detailpagina is dezelfde SSR HTML met dezelfde JobPosting-JSON-LD `description` als de listing's eigen `content`-veld (al gewhitelist en al gebruikt voor `beschrijving`) — dus geen ontbrekende tweede fetch, geen nieuwe fetch-stage nodig. Eén van de 18 records bevat toevallig een "Functie-eisen / Competenties" `<ul><li>` binnen die vrije-tekst `content` (recruiter-specifieke templatekeuze, 1/18, geen consistent structureel patroon) — dat is vrije-tekst-mining (GAP_ENRICH, CTP-482), niet een gestructureerd `tags`/`skills`-veld, dus niet geïmplementeerd. Geen enkel veld in de ~90 rauwe sleutels noemt opleidingsniveau/education. De eerdere `tags`/`tagNames`-whitelist-toevoeging (commit 76e8e78) is teruggedraaid — niets speculatiefs blijft staan.
- **F09 tarief, F08 uren, F10/F13 start/sluiting — geverifieerd correct tegen de 4 beschikbare live fixture-records.** Handmatige doorrekening van `parseTariefFromText` tegen alle vier `content`-teksten in `fixtures/connectors/inhuurdesk/listing-page-0.json` gaf de juiste min/max/eenheid voor elk record (incl. het "tussen €95,00 en €109,00"-bereik en het "max. €110"-geval), consistent met de 7/21-tarief-dekking die deze doc al documenteert. `startDate`/`endDate`/`closingDateClient` komen al uit gestructureerde ISO-velden, niet uit vrije tekst. Geen reproduceerbaar defect gevonden binnen de scope van deze 4 samples — geen wijziging aangebracht om niet te gokken zonder bewijs (zie CONTRACT.md).

## Known-hash short-circuit (RJC-357 / RJC-401)

`listingHashCoversDetail: true` — de fetch her-serialiseert de listing-rij zonder tweede request, dus `hashInhuurdeskListingItem` dekt **elk** whitelist-veld. De coverage-test in `inhuurdesk.spec.ts` vergelijkt de variant-lijst met de sleutels van `projectInhuurdeskAssignment`, zodat een nieuw whitelist-veld zonder hash-dekking de test breekt.

## Durable feed-cohort (CTP-629, bewezen 2026-09-20)

Inhuurdesk is bewezen op het duurzame ingestpad (`curated.durable_job` + `POLLER_DURABLE_BRONNEN`). De connector zelf is ongewijzigd — de migratie is een bewijslast, geen codewijziging.

**Live-probe 2026-09-20** (`/private/tmp/w8-evidence/feed-cohort/`): `?page=0` en `?page=1` geven byte-identieke responses (beiden `total: 20`, `data.length: 20`) — de 1-indexering uit 2026-09-03 is onveranderd, dus `checkpoint?.page ?? 1` blijft correct. `?page=2` → 200, `total: 20`, `data: []` — de staartpagina is leeg; met `pageSize = 20` stopt de connector al na pagina 1 (`page * pageSize < total` is onwaar).

**Resume-contract** (`packages/connectors/src/inhuurdesk/durable-cohort.spec.ts`, 4 specs): het checkpoint is `{page, pageSize}` (1-geïndexeerd); een duurzame herval leest alleen pagina's ná het checkpoint en erft de `pageSize` uit de eerste run — zelfs als de bron de paginagrootte zou wijzigen. Head-insert tussen attempts → her-observatie, geabsorbeerd door de replay-dedupe. **Resterende kloof (eerlijk):** een delisting vóór de cursor wordt door de hervatte run overgeslagen; geen tombstone (hervatte run is nooit compleet), genezing via de volgende verse poll vanaf pagina 1.

**Completeness/`truncated`:** geen paginalimiet; `hasMore` stopt op `data.length === 0` óf `page * pageSize >= total`. `truncated` blijft afwezig — de enige eerlijke waarde onder het RJC-397-contract.

**End-to-end op de echte pipeline** (fixture-client, `ji_test_iso_*`-Postgres): offer → `runDurableBronJobConsumer` → `runBronIngestPipeline` → observaties, `source_record`s en curated `aanvraag`-rijen; gefaalde run → herval (`reopenFailed`, fence +1) → resume vanaf checkpoint; abort mid-item → run `failed` (persistence-abort is nooit "benign", CTP-490) → retake leest de staart alsnog — geen verlies, exact-één. Bewijs: `apps/worker/src/poller/feed-cohort.integration.spec.ts` (6 specs, groen), meegecommit als test-only bewijs — `apps/worker` viel buiten de lane-owned paths, dus deze lane raakt daar bewust geen productiecode, alleen deze spec.

**Canary en rollback:** eerst `POLLER_DURABLE_BRONNEN=tenderned`, dan `,inhuurdesk` toevoegen — één bron tegelijk. Rollback = slug uit de vlag halen; in-flight jobs lopen leeg, er ontstaat geen dubbele scheduling (`main.ts` returnt voor de inline poll). Geen dataverlies geclaimd buiten het bovenstaande bewijs.
