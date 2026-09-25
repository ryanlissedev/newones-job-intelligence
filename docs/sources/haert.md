# Haert (haert.nl, Driessen Groep) — ingest-recept

Status: **probe afgerond; connector toegevoegd** — JSON-LD sitemap-discovery (CTP-607).

## Endpoints

| Doel | URL |
|---|---|
| Sitemap (urlset, één document) | `https://www.haert.nl/sitemap.xml` |
| Listing (SSR, gepagineerd) | `https://www.haert.nl/opdrachten` (`?page=0..4`) |
| Detail | `https://www.haert.nl/opdrachten/<slug>-<id>` |

## Discovery

`kind: "sitemap"` op `/sitemap.xml`: één Drupal-urlset (131 URL's op
2026-09-17) die CMS-, kennis- en topopdrachtgeverpagina's met de opdrachten
mengt. `excludePatterns` houdt alleen de exacte detailvorm
`/opdrachten/<slug>-<id>` over — elke live detail-URL eindigt op de numerieke
opdracht-id, die ook als JobPosting-`identifier` terugkomt. De blote
`/opdrachten`-listing en alle overige paden vallen af. Resultaat: 44
detail-URL's.

De HTML-listing is géén alternatief: die toont tien kaarten per pagina en
pagineert via `?page=N` (vijf pagina's waargenomen) — de sitemap dekt alles in
één request en staat in robots.txt vermeld (`Sitemap:`-regel).

## Veldmapping → canoniek `aanvraag`

| JSON-LD | Canoniek | Noot |
|---|---|---|
| `title` | `titel` | Letterlijk. |
| `description` | `beschrijving` | HTML in de bron; eindklant staat in de vrije tekst ("bij Gemeente …") en wordt niet gemined. |
| `hiringOrganization.name` | `opdrachtgeverNaam` | Altijd `Haert` (broker); `eindklant_naam` blijft null. |
| `jobLocation.address.addressLocality` | `locatieTekst` | `addressCountry` is `NL`. |
| `datePosted` | `bronSpecifiek.publicatiedatum` | Datum zonder tijd. |
| `validThrough` | `sluitingsdatum` | Aanwezig op alle samples. |
| `employmentType` | `bronSpecifiek.contract_type` | `CONTRACTOR`. |
| `identifier` | `bronSpecifiek.identifier` | Numerieke opdracht-id; matcht het URL-achtervoegsel. |
| `baseSalary` | `tarief` | `MonetaryAmount` EUR, `QuantitativeValue` `unitText: HOUR`, één `value` (min=max). Geen placeholder-waarde waargenomen. |
| start-/einddatum inzet, uren | UNKNOWN / label-block afwezig | Uren staan alleen in vrije tekst ("18 uur per week"); geen gestructureerd label-block op de pagina. |

## Robots, voorwaarden en fixtures

`robots.txt` is Drupal-default: alleen CMS-/account-/zoekpaden disallowed;
`/opdrachten`, de detailpaden en `sitemap.xml` zijn toegestaan →
`voorwaardenStatus: te_toetsen`, `crawlDelayMs` 2000,
`listingHashCoversDetail: false` (sitemap dekt alleen URL+lastmod, geen
detailvelden).

GATE-0 gehaald (2026-09-17, browser-UA): `/content/algemene-voorwaarden` linkt
naar de AV-PDF van Haert B.V. (`hub.driessengroep.nl/…/download`, 4 pagina's,
standaard inkoopvoorwaarden: definities, tariefaanpassing, betaling,
overname, intellectueel eigendom van opdrachtresultaten, aansprakelijkheid) —
géén scraping-, bot-, crawl- of databankclausule. `/content/disclaimer` is een
standaard juistheids-/beschikbaarheidsdisclaimer zonder gebruiksverbod. Geen
consent- of WAF-poort waargenomen op browser-UA noch op de fixture-UA.

Fixtures: `tools/fixtures/record.ts`, standaardstrips. Op de detailpagina's
staan recruiter-contactgegevens in de tekst; e-mail en telefoon zijn
mechanisch geredigeerd (zie `captureNote` per fixture).

## Voorwaarden

- robots.txt: www.haert.nl: HTTP 200, geen Disallow op connectorpaden (/, /opdrachten/), geprobed 2026-09-25
- ToS/gebruiksvoorwaarden: zie "Robots, voorwaarden en fixtures" hierboven
- Besluit: `te_toetsen`
- Besluitnemer en datum: open voor Robbie (geen besluit vastgelegd)

## Durable ingest-pad (CTP-639, bewezen 2026-09-21)

Haert is bewezen op het duurzame ingestpad (`curated.durable_job` +
`POLLER_DURABLE_BRONNEN`) als onderdeel van de L3c mixed-adapter-cohort
(CTM + Flinter + Freelancer.nl + Haert). De connector en source-definitie
zijn ongewijzigd — de migratie is een bewijslast, geen codewijziging.

**Live-probe 2026-09-21:** `https://www.haert.nl/sitemap.xml` → 200,
~20 KB urlset; 131 `<loc>`-entries waarvan 44 de exacte detailvorm
`/opdrachten/<slug>-<id>` matchen.

**Resume-contract** (`packages/connectors/src/json-ld/durable-cohort-l3c.spec.ts`,
5 specs): discovery is één enkele sitemap-pass — `discover()` geeft het hele
gefilterde corpus terug met `hasMore: false` en een inert `checkpoint: {}`,
dezelfde vorm als de CTP-630/CTP-637/CTP-638 JSON-LD-cohorten. Er is géén
pagina-cursor: een duurzame herval op hetzelfde `scrapeRunId` leest de
sitemap én elke detailpagina opnieuw, en de observatie-replay-sleutel
(`scrapeRunId + bronReferentie + contentHash`) absorbeert al-persisteerde
items — exact-één, geen verlies. `listingHashCoversDetail: false` — geen
`knownHashes`: de sitemap-metadata dekt de detail-JobPosting niet, dus elke
item kost een detailfetch. Een head-insert wordt al door de herval zelf
gezien; een delisting valt uit de enumeratie en telt via `complete: true`
meteen mee in de missed-poll-reconcile.

**Fixture-corpus (eerlijk):** de committed listing-fixture is de echte
sitemap-opname (131 `<loc>`-entries; 44 detail-URL's na filtering), waarvan
er 3 een detail-fixture hebben (`hr-adviseur-39565`,
`projectleider-energietransitie-98858`, `zwemonderwijzer-13184`). De
integratiespec scope de écht geparse sitemap daarom op de detail-backed
URL's; elke gepersisteerde payload is een echte opname.
Heel-corpus-enumeratie is los vastgelegd in de connector-spec.

**End-to-end op de echte pipeline** (fixture-client, `ji_test_iso_*`-Postgres,
`apps/worker/src/poller/l3c-cohort.integration.spec.ts` — 5 specs per bron,
groen): offer → `runDurableBronJobConsumer` → `runBronIngestPipeline` →
observaties, `source_record`s, curated `aanvraag`-rijen en `outbox_event`s;
herhaalde run → alles `unchanged`, geen duplicaten of extra versies;
gewijzigde detail-payload → `changed`-observatie → nieuwe `aanvraag_versie`
+ bijgewerkte curated rij; gefaalde sitemap-read → run `failed`
(`DISCOVER_FAILED`) → herval via `reopenFailed` (fence +1) → volledige
her-enumeratie; abort mid-item → `failed` (`RAW_STORE_WRITE_FAILED` —
persistence-abort is nooit benign, CTP-490) → retake exact-één.

**UI-bewijs (geseedde stack):** wegwerp-DB `ji_ctp639_visual_l3c` (door deze
lane aangemaakt), aanvragen gesaaid via het echte duurzame pad met
Manticore-drain (`SEARCH_PROJECTOR=worker`), API `localhost:3000` + web
`localhost:3002` zonder `NEXT_PUBLIC_USE_FIXTURES` (:3001 was door een
operator-SSH-tunnel bezet): `/jobs?source=haert&archief=1` rendert alle 3
rijen met Bron-chip `Haert` — 1 `OPEN` actief plus 2 `GESLOTEN` door de
échte opgenomen `validThrough`-datums. Captures: `/tmp/ctp639-visual/`
(H.264 MP4 + PNG, geopend en in frame bevestigd).

**Canary en rollback:** `POLLER_DURABLE_BRONNEN` per bron toevoegen, één
tegelijk, ná de CTP-630/CTP-637/CTP-638-cohorten. Rollback = slug uit de
vlag halen; in-flight jobs lopen leeg, geen dubbele scheduling (`main.ts`
returnt voor de inline poll). `HAERT_LIVE` blijft uit — dit bewijs is
fixture-only. Operator-canary en release-gate blijven open.
