# ProRail (werkenbijprorail.nl) — ingest-recept

Status: **probe afgerond; connector toegevoegd** — JSON-LD Path A (CTP-580).

## Endpoints

| Doel | URL |
|---|---|
| Listing API | `https://www.prorail.nl/nl/api/v1/vacancysearch?page=1&pageSize=50` |
| Detail | `https://www.werkenbijprorail.nl/vacatures/(functie|verkeersleiding)/<slug>` |

`www.prorail.nl/werken-bij` bestaat niet (404); de corporate site linkt naar `werkenbijprorail.nl`.

## Discovery

De HTML listing heeft geen bruikbare links en de sitemap bevat stale/404
detail-URL's. De connector gebruikt daarom de API als autoritatieve bron en
volgt `hits[].pageUrl`, waarbij `/vacatures/<category>/<slug>` behouden blijft.
De connector leest `pagination.page`, `pagination.pageSize` en
`pagination.totalMatching` en haalt alle benodigde pagina's op met dezelfde
`pageSize`. De API retourneert momenteel alle 16 vacatures op één pagina bij
`pageSize=50`.

## Veldmapping → canoniek `aanvraag`

| JSON-LD | Canoniek | Noot |
|---|---|---|
| `title` | `titel` | Letterlijk. |
| `description` | `beschrijving` | HTML in de bron. |
| `hiringOrganization.name` | `opdrachtgeverNaam` | `ProRail`, directe werkgever. |
| `jobLocation.address.addressLocality` | `locatieTekst` | `addressCountry` is `Nederland`, `addressRegion` is `NL` (omgekeerd op de bron). |
| `datePosted` | `bronSpecifiek.publicatiedatum` | Datum zonder tijd. |
| `validThrough` | `sluitingsdatum` | Aanwezig op beide samples. |
| `employmentType` | `bronSpecifiek.contract_type` | `Full-time` blijft bronwaarde. |
| `workHours` | `bronSpecifiek.uren_per_week` | Vrije tekst (`32-36`), gedeelde parser. |
| `baseSalary` | UNKNOWN | JSON-LD bevat geen `unitText`; tarief is onbetrouwbaar tot CTP-606. |
| `applicationContact` | — | Recruiter-e-mail (PII); niet gebruikt en uit de fixtures verwijderd. |

## Robots, voorwaarden en fixtures

`robots.txt`: alleen `/EPiServer/CMS/` en `/Util/` disallowed; sitemap gepubliceerd. Disclaimer bevat een standaard IE-clausule ("alleen voor niet-commerciële privédoeleinden") zonder expliciete scraping-clausule → `voorwaardenStatus: te_toetsen`, `crawlDelayMs` 2000. `listingHashCoversDetail: false`.

Fixtures: `tools/fixtures/record.ts` met extra strips `prorail-accordion`, `section.vacancy-faq`, `a[href^="mailto:"]` (recruiterblokken); daarna is de sleutel `applicationContact` mechanisch uit de JobPosting-JSON-LD verwijderd.

## Voorwaarden

- robots.txt: www.prorail.nl: HTTP 200, geen Disallow op connectorpaden (/nl/api/v1/, /, /vacatures/functie/, /vacatures/verkeersleiding/), geprobed 2026-09-25
- ToS/gebruiksvoorwaarden: zie "Robots, voorwaarden en fixtures" hierboven
- Besluit: `te_toetsen`
- Besluitnemer en datum: open voor Robbie (geen besluit vastgelegd)
