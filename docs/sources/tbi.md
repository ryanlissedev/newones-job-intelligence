# TBI — ingest-recept

Status: **probe afgerond; connector toegevoegd** — adapter-categorie `json-ld`.
TBI's Drupal werkenbij-hub gebruikt ubeeo als ATS en publiceert op canonieke
vacaturepagina's een `JobPosting` JSON-LD-node. De connector gebruikt alleen de
sitemap en detail-URL's; facet/query-URL's worden niet gecrawld.

## Endpoints

| Doel | URL | Opmerking |
|---|---|---|
| Vacaturelijst | `GET https://werkenbij.tbi.nl/vacatures` | Drupal careers hub; listing root is geen detaildiscovery. |
| Sitemap | `GET https://werkenbij.tbi.nl/sitemap.xml` | Ongeveer 608 `/vacatures/`-locs plus ongeveer 66 niet-vacaturelocs in de inventaris van 2026-09-16. |
| Sample detail | `https://werkenbij.tbi.nl/vacatures/service-technicus-w-1280611` | Canonieke detailpagina met JobPosting JSON-LD. |

## Discovery en ATS

De sitemap is de enige discoverybron. Alleen URLs met de vorm
`https://werkenbij.tbi.nl/vacatures/<slug>` blijven behouden. De listing-root,
home, `/ondernemingen/...`, `/node/...`, andere niet-vacaturepaden en URLs met
een querystring worden uitgesloten. De sample heeft identifier `1280611` en
`hiringOrganization.@id` `ubeeo-8038`; dit is een ubeeo-integratie, geen
Workday-, Greenhouse- of andere ATS-route.

## Veldmapping → canoniek `aanvraag`

| TBI JobPosting JSON-LD | Canoniek | Provenance/noot |
|---|---|---|
| `title` | `titel` | Sample: `Service Technicus W`. |
| `description` | `beschrijving` | Gepubliceerde korte teaser, zonder synthetische tekst. |
| Detail-URL | `bron_referentie` / `bronUrl` | Canonieke sitemap/detail-URL; de JobPosting heeft geen `url`-veld. |
| `identifier.value` | `bronSpecifiek.identifier.value` | Sample: `1280611`; `identifier.name` is `Croonwolter&dros`. |
| `datePosted` | `bronSpecifiek.publicatiedatum` | Sample: `2026-05-23T12:36:00+02:00`. |
| `employmentType` | `bronSpecifiek.contract_type` | Sample: `Fulltime`. |
| `hiringOrganization.@id` | `bronSpecifiek`-bronwaarde | ubeeo ATS-id `ubeeo-8038`. |
| `hiringOrganization.name` | `opdrachtgeverNaam` | `Croonwolter&dros` als hiring organization; TBI is de careers-hub. |
| `jobLocation.address.addressLocality` | `locatieTekst` | Sample: `Amersfoort`. |
| `jobLocation.address.addressCountry` | `locatieLand` | Sample: `NL`; shared normaliser zet dit canoniek op `NL`. |
| `qualifications` / `occupationalCategory` | JSON-LD bronpayload | Sample: `MBO` / `Uitvoering Techniek`; JSON-LD-only, geen label block nodig. |

Tarief, startdatum en sluitingsdatum worden niet ingevuld wanneer TBI ze niet
publiceert. `voorwaardenStatus` blijft `te_toetsen`; deze bron is niet Gate0.

## Robots, crawl delay en known hashes

TBI's robotsregels bevatten `Disallow: /*?`; query/facet-URL's mogen daarom niet
worden gebruikt. De connector volgt de sitemap en canonieke detail-URL's en
crawlt geen filters. De seed gebruikt een crawl delay van 2000 ms.

`listingHashCoversDetail: false`: sitemapmetadata beschrijft de URL-entry en
niet de JobPosting-body. Known hashes worden daarom niet naar de connector
doorgegeven, zodat wijzigingen op detailpagina's niet worden overgeslagen.

## Durable JSON-LD-cohort (CTP-641, bewezen 2026-09-25)

TBI is bewezen op het duurzame ingestpad (`curated.durable_job` +
`POLLER_DURABLE_BRONNEN`). De connector en source-definitie zijn ongewijzigd —
de migratie is een bewijslast, geen codewijziging.

**Live-probe 2026-09-25:** `https://werkenbij.tbi.nl/sitemap.xml` → 200,
~122 KB urlset met detaillinks.

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
sitemap-opname (5 `<loc>`-entries; 2 vacaturevorm-URL's na uitsluiting),
waarvan er 1 een detail-fixture heeft (`service-technicus-w-1280611`). De
integratiespec scope de écht geparse listing op de detail-backed URL's; elke
gepersisteerde payload is een echte opname. Er is géén opgenomen
soft-404/reject-fixture voor deze bron. Heel-corpus-enumeratie is los
vastgelegd in de connector-spec.

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
`NEXT_PUBLIC_USE_FIXTURES`: `/jobs` toont in de Bron-facet `TBI 1`;
`?source=tbi` rendert de 1 rij. Captures: `/tmp/ctp641-visual/` (H.264 MP4 +
PNG, geopend en in frame bevestigd). Archief-toggle niet van toepassing — de
seed is actief.

**Canary en rollback:** `POLLER_DURABLE_BRONNEN` per bron toevoegen, één
tegelijk, ná de CTP-630/CTP-637/CTP-638-cohorten. Rollback = slug uit de vlag
halen; in-flight jobs lopen leeg, geen dubbele scheduling (`main.ts` returnt
voor de inline poll). `TBI_LIVE` blijft uit — dit bewijs is fixture-only.
Operator-canary en release-gate blijven open.

## Voorwaarden

- robots.txt: werkenbij.tbi.nl: HTTP 200, geen Disallow op connectorpaden (/, /vacatures/), geprobed 2026-09-25
- ToS/gebruiksvoorwaarden: niet gevonden
- Besluit: `te_toetsen`
- Besluitnemer en datum: open voor Robbie (geen besluit vastgelegd)
