# Jobbird — ingest-recept

Status: **probe afgerond; connector toegevoegd** — adapter-categorie `json-ld`.
Deze connector is beperkt tot de freelance/zzp-categorie.

## Endpoints

| Doel | URL | Opmerking |
|---|---|---|
| Freelance listing | `GET https://www.jobbird.com/nl/dienstverband/freelance-zzp` | 15 detail-links op pagina 1 bij capture. |
| Detail | `https://www.jobbird.com/nl/vacature/25796307-freelance-inkoper-sociaal-domein-zzp` | JobPosting JSON-LD. |

## Discovery en ATS

De listing is gevonden via `landing-pages.xml?type=contract-type`, waarin ook
`/nl/dienstverband/interim-opdrachten` en niet-freelancecategorieën staan. De
freelance/zzp-pagina is daarom de relevante, deterministische listing surface.
De connector haalt één pagina: de 15 links op pagina 1 voldoen aan
`/^\/nl\/vacature\/\d+-[^/]+$/u`; pagination naar pagina 2 valt vandaag buiten
scope. De `JobPosting.url`-velden zijn appcast.io-trackingredirects; de
connector-URL blijft leidend voor `bronUrl` en `bronReferentie`.

## Veldmapping → canoniek `aanvraag`

| JobPosting JSON-LD | Canoniek | Provenance/noot |
|---|---|---|
| `title` | `titel` | De drie letterlijke freelance-titels. |
| `description` | `beschrijving` | Gepubliceerde JobPosting-beschrijving. |
| Detail-URL | `bron_referentie` / `bronUrl` | Jobbird-detail-URL, niet de appcast-URL. |
| `identifier.value` | `bronSpecifiek.identifier.value` | `25796307`, `25849909`, `25852520`. |
| `datePosted` | `bronSpecifiek.publicatiedatum` | Gepubliceerde timestamps; respectievelijk 2026-09-09, 2026-09-15 en 2026-09-16. |
| `employmentType` | `bronSpecifiek.contract_type` | `PART_TIME`; gepubliceerd als array. |
| `baseSalary` | `tarief` | Afwezig in alle drie: UNKNOWN, geen parsing gap. |
| `validThrough` | sluitingsmoment/status | Afwezig in alle drie: UNKNOWN, geen parsing gap. |
| `hiringOrganization.name` | `opdrachtgeverNaam` | `Randstad Freelance` is de broker/board, niet de eindklant. `eindklant_naam` blijft UNKNOWN volgens de gedeelde regel; geen expliciet `eindklant`-veld. |
| `jobLocation.address.addressLocality` / `addressRegion` / `addressCountry` | locatie | OIRSCHOT/Oirschot/NL, LEEUWARDEN/Gemeente Leeuwarden/NL, LISSE/Lisse/NL. |

## Robots, crawl delay en known hashes

`robots.txt` disallowt `/nl/job_*`, `/*/api`, `/*/xml` en `/*/ajax/*`, maar niet
de gebruikte categorie-, detail- of sitemappaden. De seed gebruikt 2000 ms.
Fixture-captures: listing `2026-09-16T20:17:34.127Z`, inkoper
`2026-09-16T20:17:51.323Z`, controller `2026-09-16T20:17:59.025Z`, adviseur
`2026-09-16T20:18:07.013Z`.

`listingHashCoversDetail: false`: listingmetadata dekt de detail-JobPosting
niet. Known hashes worden daarom niet doorgegeven.

## Voorwaarden

- robots.txt: www.jobbird.com: HTTP 200, geen Disallow op connectorpaden (/nl/dienstverband/, /nl/vacature/), geprobed 2026-09-25
- ToS/gebruiksvoorwaarden: niet gevonden
- Besluit: `te_toetsen`
- Besluitnemer en datum: open voor Robbie (geen besluit vastgelegd)
