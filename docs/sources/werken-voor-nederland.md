# Werken voor Nederland — ingest-recept

Status: **probe afgerond; connector toegevoegd** — adapter-categorie `json-ld`.
Werken voor Nederland is de Rijk-carrièrehub voor permanente en tijdelijke
vacatures. Dit is geen alias van Opdrachtoverheid/TenderNed: het publiceert
Rijk-carrièrevacatures, geen DAS-inhuurmarktplaats.

## Endpoints

| Doel | URL | Opmerking |
|---|---|---|
| Vacature-sitemap | `GET https://www.werkenvoornederland.nl/sitemap-vacatures.xml` | Gerichte v1-discovery; de live inventaris bevat ongeveer 1221 `<loc>`-entries. |
| Listing | `GET https://www.werkenvoornederland.nl/vacatures` | Careers hub; niet als detail-URL crawlen. |
| Detail | `GET https://www.werkenvoornederland.nl/vacatures/<slug>` | Detailpagina met een `JobPosting` JSON-LD-node. Sitemap-URL's worden exact behouden. |
| Sample detail | `https://www.werkenvoornederland.nl/vacatures/kubernetes-software-platform-engineer-CJIB-2026-9570` | JSON-LD identifier `69005`. |

v1 leest alleen `sitemap-vacatures.xml`. `robots.txt` noemt ook
`sitemap.xml`, maar de connector implementeert geen sitemap-index of
multi-sitemap crawling.

## Veldmapping → canoniek `aanvraag`

| Werken voor Nederland JSON-LD | Canoniek | Provenance/noot |
|---|---|---|
| `title` | `titel` | Sample: `Kubernetes Software Platform Engineer`. |
| `description` | `beschrijving` | De korte JSON-LD-teaser blijft ongewijzigd; er wordt geen rijkere body verzonnen. |
| URL-pad | `bron_referentie` | Sample: `vacatures/kubernetes-software-platform-engineer-CJIB-2026-9570`; niet vervangen door identifier `69005`. |
| `identifier.value` | `bronSpecifiek.identifier.value` | Sample: `69005`; `identifier.name` is de publicerende ministerie/CJIB-context. |
| `datePosted` | `bronSpecifiek.publicatiedatum` | Sample: `2026-09-09`. |
| `employmentType` | `bronSpecifiek.contract_type` | Sample: `TEMPORARY` als string. |
| `hiringOrganization.name` | `opdrachtgeverNaam` | Sample: `Centraal Justitieel Incassobureau`; leading whitespace wordt door de shared normaliser getrimd. |
| `jobLocation.address.addressLocality` | `locatieTekst` | Sample: `Leeuwarden`. |
| `jobLocation.address.addressCountry` | `locatieLand` | Sample: `NL`. |
| `baseSalary` | `tarief` | EUR/month band `4818`–`7094`; de shared `tariefFromBaseSalary` mapping promotes `MONTH` to `maand`. |
| `validThrough` | sluitingsmoment | Sample: `2026-11-02`. |

## Ingest-patroon

- Lees één sitemap-urlset via `sitemap-vacatures.xml`.
- Behoud detail-URL's met exact één segment na `/vacatures`; sluit de listing
  root, `/login` en overige niet-detail-URL's uit.
- Respecteer een crawl-delay van 2 seconden. `robots.txt` vermeldt
  `Request-rate: 10/1`, `Visit-time: 0000-2400` en `Disallow: /login`.
- Er is geen betrouwbaar bron-specifiek labelblok in de capture; mapping is
  daarom JSON-LD-only.

## Robots en voorwaarden

De robots-capture staat `Disallow: /login` en noemt beide sitemaps. In de
privacy/voorwaarden-skim is geen scrapeverbod gevonden; de status blijft
`voorwaardenStatus: "te_toetsen"` vóór activatie.

## Voorwaarden

- robots.txt: www.werkenvoornederland.nl: HTTP 200, geen Disallow op connectorpaden (/, /vacatures/), geprobed 2026-09-25
- ToS/gebruiksvoorwaarden: zie "Robots en voorwaarden" hierboven
- Besluit: `te_toetsen`
- Besluitnemer en datum: open voor Robbie (geen besluit vastgelegd)

## Overlap en known hashes

Werken voor Nederland is **geen ALIAS** van Opdrachtoverheid/TenderNed. De
bron heeft eigen Rijk-carrièrevacatures en een eigen bron-identiteit.

`listingHashCoversDetail: false`: de sitemap-hash ziet alleen URL en
`lastmod`, terwijl de relevante JobPosting-velden op de detailpagina staan.
De known-hash-store wordt daarom niet doorgestuurd, zodat detail-only
wijzigingen niet worden overgeslagen (RJC-357/RJC-401, dezelfde beslissing als
Bij Oranje).

## Durable JSON-LD-cohort (CTP-638, bewezen 2026-09-21)

Werken voor Nederland is bewezen op het duurzame ingestpad
(`curated.durable_job` + `POLLER_DURABLE_BRONNEN`). De connector en
source-definitie zijn ongewijzigd — de migratie is een bewijslast, geen
codewijziging.

**Live-probe 2026-09-21:**
`https://www.werkenvoornederland.nl/sitemap-vacatures.xml` → 200, ~289 KB
urlset met detaillinks.

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

**Fixture-corpus (eerlijk):** de committed listing-fixture is een ingekorte
echte sitemap-opname (2 `<loc>`-entries; het live-inventaris telt ~1221),
waarvan er 1 een detail-fixture heeft
(`kubernetes-software-platform-engineer-CJIB-2026-9570`). De integratiespec
scope de écht geparse listing daarom op de detail-backed URL; de gepersisteerde
payload is een echte opname. Er is géén opgenomen soft-404/reject-fixture voor
deze bron. Heel-corpus-enumeratie is los vastgelegd in de connector-spec.
Gevolg voor het abort-bewijs: met één fixture-item valt de abort op de eerste
detail-read — er is geen pre-abort observatie om te absorberen; de retake
schrijft het item vers (dezelfde eerlijke inperking als ASML in CTP-637). De
replay-absorptie is voor deze bron bewezen in de connector-spec met een gescript
corpus.

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
`NEXT_PUBLIC_USE_FIXTURES`: `/jobs` toont in de Bron-facet
`Werken voor Nederland 1`; `?source=werken-voor-nederland` rendert de rij.
Captures: `/tmp/ctp638-visual/` (H.264 MP4 + PNG, geopend en in frame
bevestigd). Archief-toggle niet van toepassing — alle seeds zijn actief.

**Canary en rollback:** `POLLER_DURABLE_BRONNEN` per bron toevoegen, één
tegelijk, ná de CTP-630/CTP-637-cohorten. Rollback = slug uit de vlag halen;
in-flight jobs lopen leeg, geen dubbele scheduling (`main.ts` returnt voor de
inline poll). `WERKEN_VOOR_NEDERLAND_LIVE` blijft uit — dit bewijs is
fixture-only. Operator-canary en release-gate blijven open.
