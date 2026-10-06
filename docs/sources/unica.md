# Unica — ingest-recept

Status: **probe afgerond; connector toegevoegd** — adapter-categorie `json-ld`.

## Endpoints

| Doel | URL | Opmerking |
|---|---|---|
| Sitemap | `GET https://www.werkenbijunica.nl/sitemap.xml` | 589 URLs; 558 hebben de vacaturevorm; `/vacatures/favorieten` is navigatieruis. |
| Detail | `https://www.werkenbijunica.nl/vacatures/<slug>-<id>` | JobPosting JSON-LD. |

## HTTP 5xx op detailpagina's

Op 6 oktober 2026 gaf ongeveer 4 % van de vacatures uit de Unica-sitemap (17
van de eerste 407 geprobeerde, onder meer
`/vacatures/technisch-administratief-medewerker-goes-amstgehjgo1zm6l`) bij elk
verzoek HTTP 500 (Laravel "Server Error"); de rest gaf 200. Omdat alleen 404
een item afkeurde, liet elk van die pagina's de hele Unica-run falen met
`ConnectorRunFailure` ("Connector fetch failed").

`unicaConfig.detailServerErrorPolicy` probeert een 5xx op een detailpagina drie
keer (wachttijd 1 s, daarna 2 s). Blijft de pagina falen, dan wordt het item
afgekeurd (`rejected`) en loopt de run door; het blijft in
`observedBronReferenties`, dus missed-poll-reconciliatie markeert het niet als
verdwenen. Vallen er in één run meer dan 100 pagina's (~18 % van de catalogus) zo af, dan ligt Unica zelf
plat en faalt de run zoals voorheen. Een 5xx op de sitemap faalt de run altijd.
Bewijs: `packages/connectors/src/json-ld/unica-server-error.spec.ts`.

## Veldmapping

| JSON-LD | Canoniek | Provenance/noot |
|---|---|---|
| `title`, `description`, `datePosted` | titel, beschrijving, publicatiedatum | Detailpagina. |
| `hiringOrganization.name` | `opdrachtgeverNaam` | Werkgever per listing: `Unica Building Services Oosterhout` of `Brainpact`; niet herschreven naar de groepsnaam. |
| `jobLocation.address.addressLocality` | `locatieTekst` | Land is gedeeld `NL`. |
| `addressRegion` | `bronSpecifiek.provincie` | `Limburg` canonicaliseert; `North Brabant` niet, omdat de gedeelde aliasmap alleen Nederlandse Noord-Brabant-aliases bevat. |
| `baseSalary.value` | `tarief` | MONTH, letterlijk overgenomen. |
| `validThrough` | `sluitingsdatum` | Per listing gepubliceerd. |

`crawlDelayMs` is 2000 en `voorwaardenStatus` `te_toetsen`. De sitemap bevat alleen URL/lastmod, dus `listingHashCoversDetail: false`; known hashes worden niet doorgestuurd.

## Durable JSON-LD-cohort (CTP-638, bewezen 2026-09-21)

Unica is bewezen op het duurzame ingestpad (`curated.durable_job` +
`POLLER_DURABLE_BRONNEN`). De connector en source-definitie zijn ongewijzigd —
de migratie is een bewijslast, geen codewijziging.

**Live-probe 2026-09-21:** `https://www.werkenbijunica.nl/sitemap.xml` → 200,
~149 KB urlset met detaillinks.

**Resume-contract** (`packages/connectors/src/json-ld/durable-cohort-l3b.spec.ts`,
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
sitemap-opname (589 `<loc>`-entries; 558 vacaturevorm-URL's na uitsluiting),
waarvan er 8 een detail-fixture hebben (`accountmanager-venray-...`,
`beheertechnicus-warmtenetten-oosterhout-...`, `energie-manager-moordrecht-...`,
`financieel-administratief-medewerker-groningen-...`,
`service-coordinator-oosterhout-...`, `servicemonteur-warmtenetten-...`,
`technisch-administratief-medewerker-oosterhout-...`,
`werkvoorbereider-warmtenetten-oosterhout-...`). De integratiespec scope de écht
geparse listing daarom op de detail-backed URL's; elke gepersisteerde payload is
een echte opname. Er is géén opgenomen soft-404/reject-fixture voor deze bron —
alle acht de detail-URL's persisteren. Heel-corpus-enumeratie is los vastgelegd
in de connector-spec.

**End-to-end op de echte pipeline** (fixture-client, `ji_test_iso_*`-Postgres,
`apps/worker/src/poller/json-ld-cohort-l3b.integration.spec.ts` — 5 specs per
bron, groen): offer → `runDurableBronJobConsumer` → `runBronIngestPipeline` →
observaties, `source_record`s, curated `aanvraag`-rijen en `outbox_event`s;
herhaalde run → alles `unchanged`, geen duplicaten of extra versies; gewijzigd
detail-payload → `changed`-observatie → nieuwe `aanvraag_versie` + bijgewerkte
curated rij; gefaalde listing-read → run `failed` (`DISCOVER_FAILED`, gezien aan
het begin van de retake) → herval via `reopenFailed` (fence +1) → volledige
her-enumeratie; abort mid-item → `failed` (`RAW_STORE_WRITE_FAILED` —
persistence-abort is nooit benign, CTP-490) → retake exact-één.

**UI-bewijs (geseedde stack):** wegwerp-DB `ji_ctp638_visual_l3b` (door deze
lane aangemaakt én gedropt), aanvragen gesaaid via het echte duurzame pad met
Manticore-drain (`SEARCH_PROJECTOR=worker`), API :3000 + web :3001 zonder
`NEXT_PUBLIC_USE_FIXTURES`: `/jobs` toont in de Bron-facet `Unica 3`;
`?source=unica` rendert de 3 rijen. Captures: `/tmp/ctp638-visual/` (H.264 MP4 +
PNG, geopend en in frame bevestigd). Archief-toggle niet van toepassing — alle
seeds zijn actief.

**Canary en rollback:** `POLLER_DURABLE_BRONNEN` per bron toevoegen, één
tegelijk, ná de CTP-630/CTP-637-cohorten. Rollback = slug uit de vlag halen;
in-flight jobs lopen leeg, geen dubbele scheduling (`main.ts` returnt voor de
inline poll). `UNICA_LIVE` blijft uit — dit bewijs is fixture-only.
Operator-canary en release-gate blijven open.

## Voorwaarden

- robots.txt: www.werkenbijunica.nl: HTTP 200, geen Disallow op connectorpaden (/, /vacatures/), geprobed 2026-09-25
- ToS/gebruiksvoorwaarden: niet gevonden
- Besluit: `te_toetsen`
- Besluitnemer en datum: open voor Robbie (geen besluit vastgelegd)
