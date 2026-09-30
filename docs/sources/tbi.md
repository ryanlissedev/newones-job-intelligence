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

## Voorwaarden

- robots.txt: werkenbij.tbi.nl: HTTP 200, geen Disallow op connectorpaden (/, /vacatures/), geprobed 2026-09-25
- ToS/gebruiksvoorwaarden: niet gevonden
- Besluit: `te_toetsen`
- Besluitnemer en datum: open voor Robbie (geen besluit vastgelegd)
