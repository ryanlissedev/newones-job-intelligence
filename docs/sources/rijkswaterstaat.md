# Rijkswaterstaat — ingest-recept

Status: **probe afgerond; connector toegevoegd** — adapter-categorie `json-ld`.
Rijkswaterstaat is een directe werkgever op een eigen carrièreportal.

## Endpoints

| Doel | URL | Opmerking |
|---|---|---|
| Sitemap | `GET https://werkenbij.rijkswaterstaat.nl/sitemap.xml` | Brede CMS-sitemap met precies 26 vacature-details in de live inventaris. |
| Detail | `https://werkenbij.rijkswaterstaat.nl/vacatures/<slug>/<numeriek-id>` | Detailpagina met JobPosting JSON-LD. |
| Sample detail | `https://werkenbij.rijkswaterstaat.nl/vacatures/adviseur-assetmanagement-rivierbodem/1330716` | Identifier `1330716-NL-1160`; geen `validThrough`. |

## Discovery en veldmapping

De sitemap bevat CMS-pagina's, de kale `/vacatures`-root en vacaturedetails.
De whitelist-via-negative-lookahead bewaart uitsluitend
`/vacatures/<slug>/<digits>` en sluit daarmee alle overige vormen uit.

| Rijkswaterstaat JSON-LD | Canoniek | Provenance/noot |
|---|---|---|
| `title` | `titel` | Letterlijk overgenomen. |
| `description` | `beschrijving` | JSON-LD-body indien gepubliceerd. |
| URL-pad | `bron_referentie` | Het vacaturepad blijft de referentie. |
| `identifier` | `bronSpecifiek.identifier` | Inclusief `name: Rijkswaterstaat`. |
| `datePosted` | `bronSpecifiek.publicatiedatum` | Volledige ISO-timestamp blijft behouden. |
| `hiringOrganization.name` | `opdrachtgeverNaam` | `DG Rijkswaterstaat`, directe werkgever. |
| eerste `jobLocation.address.addressLocality` | `locatieTekst` | Shared normaliser gebruikt de eerste Place. |
| `baseSalary` | `tarief` | EUR/MONTH-band als getallen. |
| ontbrekend `validThrough` | sluitingsmoment | UNKNOWN; er wordt geen deadline afgeleid. |

## Robots, crawl-delay, overlap en known hashes

robots.txt noemt deze sitemap. `Disallow: /*?` en `Disallow: /*.aspx` raken de
detail-URL's niet. De connector gebruikt de projectcrawl-delay van 2 seconden.

Rijkswaterstaat valt expliciet niet onder Werken voor Nederland. Het zijn
twee echte, aparte carrièreportals met eigen sitemap en JSON-LD. De wave-2
probe (`probe-werkenbij-energy.md`) bevestigt dat zoekhits op Werken voor
Nederland geen volledige dekking van dit eigen domein aantonen. Als beide
bronnen samen worden ingelezen, adviseert de probe downstream-deduplicatie
op `(titel, opdrachtgeverNaam, locatieTekst)` in plaats van een bron boven
de andere te laten prevaleren. Deze connector implementeert die deduplicatie
niet. `listingHashCoversDetail: false`, omdat detailvelden niet in de sitemap
staan.

De fixture → connector → normalise → curate-assertie staat niet in deze
source-test: curatie vereist live Postgres via `createBronRuntimeClient` en
zou bestanden onder `apps/worker`/infra nodig hebben, buiten deze lane.

## Durable JSON-LD-cohort (CTP-641, bewezen 2026-09-25)

Rijkswaterstaat is bewezen op het duurzame ingestpad (`curated.durable_job` +
`POLLER_DURABLE_BRONNEN`). De connector en source-definitie zijn ongewijzigd —
de migratie is een bewijslast, geen codewijziging.

**Live-probe 2026-09-25:** `https://werkenbij.rijkswaterstaat.nl/sitemap.xml` →
200, ~55 KB urlset met detaillinks.

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
sitemap-opname (5 `<loc>`-entries; 3 vacature-URL's na de
numeric-detail-exclusion), en alle 3 hebben een detail-fixture
(`adviseur-assetmanagement-rivierbodem-1330716`,
`adviseur-waterveiligheid-1310882`, `jurist-handhaving-1318820`). De
integratiespec scope de écht geparse listing op de detail-backed URL's; elke
gepersisteerde payload is een echte opname. Er is géén opgenomen
soft-404/reject-fixture voor deze bron — alle drie de detail-URL's
persisteren. Heel-corpus-enumeratie is los vastgelegd in de connector-spec.

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
`NEXT_PUBLIC_USE_FIXTURES`: `/jobs` toont in de Bron-facet `Rijkswaterstaat 3`;
`?source=rijkswaterstaat` rendert de 3 rijen. Captures: `/tmp/ctp641-visual/`
(H.264 MP4 + PNG, geopend en in frame bevestigd). Archief-toggle niet van
toepassing — alle seeds zijn actief.

**Canary en rollback:** `POLLER_DURABLE_BRONNEN` per bron toevoegen, één
tegelijk, ná de CTP-630/CTP-637/CTP-638-cohorten. Rollback = slug uit de vlag
halen; in-flight jobs lopen leeg, geen dubbele scheduling (`main.ts` returnt
voor de inline poll). `RIJKSWATERSTAAT_LIVE` blijft uit — dit bewijs is
fixture-only. Operator-canary en release-gate blijven open.

## Voorwaarden

- robots.txt: werkenbij.rijkswaterstaat.nl: HTTP 200, geen Disallow op connectorpaden (/, /vacatures/adviseur-assetmanagement-rivierbodem/, /vacatures/adviseur-waterveiligheid/, /vacatures/jurist-handhaving/), geprobed 2026-09-25
- ToS/gebruiksvoorwaarden: niet gevonden
- Besluit: `te_toetsen`
- Besluitnemer en datum: open voor Robbie (geen besluit vastgelegd)
