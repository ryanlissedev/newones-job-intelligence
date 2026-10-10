# ZZP-Opdrachten.nl — ingest-recept

Status: **probe afgerond; connector toegevoegd** — adapter-categorie `json-ld`.
De connector leest de twee nieuwste sitemap-chunks en canonieke opdrachtpagina's.

## Endpoints

| Doel | URL | Opmerking |
|---|---|---|
| Sitemap-index | `GET https://www.zzp-opdrachten.nl/sitemap_index.xml` | Selecteert de twee hoogste numerieke `job-sitemap<N>.xml` chunks. Live-probe 2026-09-21: `/sitemap.xml` antwoordt met een permanente 301 naar `/sitemap_index.xml`; `robots.txt` verwijst ook naar die canonical URL. De fixture (`listing-page-0.json`, opgenomen via `/sitemap.xml`) bevat dezelfde index. |
| Sitemap-chunks | `GET https://www.zzp-opdrachten.nl/job-sitemap57.xml` en `job-sitemap58.xml` | De nieuwste twee chunks; samen vormen ze het rolling discovery window. |
| Sample detail | `https://www.zzp-opdrachten.nl/vacatures/vacature-jurist-707983/` | JobPosting JSON-LD, identifier `ZT57670`. |

## Discovery en ATS

De connector gebruikt de sitemap-index en volgt alleen de twee hoogste numerieke
`job-sitemap<N>.xml` chunks. De chunknummering is de betrouwbare volgorde-sleutel:
`<lastmod>` van de index is niet geschikt, omdat `job-sitemap.xml` zonder nummer
een recente lastmod heeft maar vacatures uit 2018–2019 bevat. De client recurst
niet verder dan deze ene indexlaag, zodat het volledige historische archief niet
wordt ingelezen.
Alleen de exacte vorm `/vacatures/vacature-<slug>-<id>/` blijft behouden.

## Hervatbare discovery-batches (CTP-624)

De twee chunks bevatten samen ~1805 vacature-URL's. `discover()` leverde die
voorheen in één pagina (`hasMore: false`, checkpoint `{}`), zodat een abort of
duurzame retry halverwege de detail-walk alles opnieuw moest enumereren. Met
`discovery.batchSize: 100` emitteert `discover()` nu maximaal 100 items per
pagina en checkpoint het runloop per pagina als
`cursor: "sitemap-index:<fingerprint>:<child>:<offset>"` — positie in het
geselecteerde corpus (welke chunk, offset daarbinnen) plus een SHA-256-vingerafdruk
(16 hex) van de geordende child-lijst uit de index. Bij hervatting in een
vers proces wordt de index opnieuw gelezen: gelijke vingerafdruk → doorgaan op
de positie; afwijkende vingerafdruk of afwezige/legacy cursor → opnieuw vanaf
positie 0 (dubbel geziene items worden door de idempotente record-laag
absorbeerd, en een hervatte run blijft `complete: false, reason: "resumed"`,
dus er vallen nooit tombstones op een incompleet beeld). `truncated` wordt niet
voor de vingerafdruk gebruikt; het behoudt zijn vaste betekenis.

Eén volledige walk kost dezelfde requests als voorheen (1× index + 1× per
geselecteerde chunk; chunks worden per run in-process gecachet). Fairness komt
uit begrensde pagina's + checkpoint-resume: chunk-reads binnen een `discover()`
blijven sequentieel onder de gedeelde `CrawlDelayLimiter` van de runloop; er is
geen connector-interne parallelliteit. `listingHashCoversDetail` blijft `false`:
alleen de known-hash-short-circuit in `fetch()` slaat ongewijzigde details over.

Restrisico: de vingerafdruk dekt de child-*lijst* van de index, niet de inhoud
van een chunk. Verandert een chunk-body tussen twee attempts terwijl de index
gelijk blijft, dan kan de offset iets verschuiven — dubbel wordt geabsorbeerd,
overgeslagen items missen hooguit één observatie (de run is toch `resumed`,
dus nooit compleet). Een child-sitemap die tijdens een walk transport-fout
geeft, faalt de pagina: de retry leest dezelfde positie opnieuw.

## Veldmapping → canoniek `aanvraag`

| JobPosting JSON-LD | Canoniek | Provenance/noot |
|---|---|---|
| `title` | `titel` | Gepubliceerd; samples: `Jurist`, `Bouwprojectmanager`, `Woonfraude Specialist`. |
| `description` | `beschrijving` | Gepubliceerde JobPosting-beschrijving. |
| Detail-URL | `bron_referentie` / `bronUrl` | De door de connector gefetchte detail-URL. |
| `identifier.value` | `bronSpecifiek.identifier.value` | `ZT57670`, `ZT57681`, `ZT58329`. |
| `datePosted` | `bronSpecifiek.publicatiedatum` | Gepubliceerd; respectievelijk 2026-09-01, 2026-09-01 en 2026-09-15. |
| `validThrough` | sluitingsmoment/status | Gepubliceerd: 2026-09-05, 2026-09-07 en 2026-09-26. |
| `employmentType` | `bronSpecifiek.contract_type` | Gepubliceerd als `TEMPORARY`; de bron levert een array. |
| `baseSalary.value.value` + `unitText` | `tarief` | EUR per uur: 80,75; 131,75; 85,00. |
| `hiringOrganization.name` | `opdrachtgeverNaam` | `ZZP Opdrachten` is de broker/board, niet de eindklant. `eindklant_naam` blijft UNKNOWN volgens de bestaande gedeelde regel; er is geen expliciet `eindklant`-veld. |
| `jobLocation.address.addressLocality` / `addressRegion` | `locatieTekst` | Maarssen/Utrecht, Heerenveen/Friesland, Haarlem/North Holland. |
| `jobLocation.address.addressCountry` | `locatieLand` | Gepubliceerd als `Nederland`; overige ongebruikte adresvelden blijven bronpayload. |

## Robots, crawl delay en known hashes

`robots.txt` bevat voor ClaudeBot `Crawl-delay: 35`. De seed gebruikt desondanks
de uniforme repositorywaarde van 2000 ms. De fixture-captures zijn:
listing `2026-09-16T20:12:35.407Z`, jurist `2026-09-16T20:12:45.616Z`,
bouwprojectmanager `2026-09-16T20:13:08.775Z`, woonfraude `2026-09-16T20:13:25.627Z`.

`listingHashCoversDetail: false`: sitemapmetadata bevat alleen URL/lastmod en
niet de JobPosting-body. Known hashes worden daarom niet doorgegeven.

## Voorwaarden

- robots.txt: www.zzp-opdrachten.nl: HTTP 200, geen Disallow op connectorpaden (/, /vacatures/vacature-bouwprojectmanager-708001/, /vacatures/vacature-jurist-707983/, /vacatures/vacature-woonfraude-specialist-710585/), geprobed 2026-09-25
- ToS/gebruiksvoorwaarden: niet gevonden
- Besluit: `te_toetsen`
- Besluitnemer en datum: open voor Robbie (geen besluit vastgelegd)

## Canary en release

De gebatchte discovery activeert pas in productie zodra de duurzame poller de
bron oppikt: `POLLER_DURABLE_BRONNEN=zzp-opdrachten`. Terugdraaien is het slug
uit die lijst halen; de connector blijft dan ongebruikt en een eerder
persisted cursor is afwaarts compatibel — een volgende run zonder checkpoint
start gewoon bij positie 0.

`packages/connectors` en de worker-ingest zijn manual-lane paths: een release
die ze raakt autodeployt niet en de `Deploy production`-gate blijft rood tot
een operator de release handmatig schippt. Dat rode signaal is het werkende
gate-gedrag, geen defect; deze change claimt dus geen autodeploy.
