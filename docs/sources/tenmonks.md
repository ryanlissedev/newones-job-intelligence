# TenMonks — ingest-recept (geverifieerd 2026-09-16)

Status: **probe afgerond; connector toegevoegd** — adapter-categorie `json-ld`.
TenMonks is een overheid-interim broker. De site gebruikt WordPress/Rank Math;
de detailpagina publiceert een `JobPosting` JSON-LD-node.

## Endpoints

| Doel | URL | Opmerking |
|---|---|---|
| Assignment sitemap | `GET https://tenmonks.nl/assignment-sitemap1.xml` | Voorkeursdiscovery voor v1; bevat de nieuwste circa 200 opdrachten. |
| Assignment sitemap 2 | `GET https://tenmonks.nl/assignment-sitemap2.xml` | Oudere circa 198 opdrachten; follow-up, niet door v1 gecrawld. |
| Sitemap-index | `GET https://tenmonks.nl/sitemap_index.xml` | Door `robots.txt` gelinkt; v1 crawlt bewust alleen assignment-sitemap1. |
| Detail | `GET https://tenmonks.nl/opdrachten/<id>/<slug>/` | Detail-URL met numeriek URL-id en trailing slash. |
| Sample detail | `https://tenmonks.nl/opdrachten/34350/data-analist/` | JSON-LD identifier `JP033750`; dit is niet hetzelfde als URL-id `34350`. |

## Veldmapping → canoniek `aanvraag`

| TenMonks JSON-LD | Canoniek | Provenance/noot |
|---|---|---|
| `title` | `titel` | Samplewaarde `Data Analist`. |
| `description` | `beschrijving` | HTML-escaped opdrachtomschrijving uit de detailpagina. |
| URL-pad | `bron_referentie` | `opdrachten/34350/data-analist`; het URL-id is niet de bronidentifier. |
| `identifier.value` | `bronSpecifiek.identifier.value` | Samplewaarde `JP033750`; de shared normaliser leest dit direct uit JobPosting. |
| `datePosted` | `bronSpecifiek.publicatiedatum` | Samplewaarde `2026-09-15`. |
| `employmentType` | `bronSpecifiek.contract_type` | Samplewaarde `FULL_TIME` (array-vorm wordt als gepubliceerd behouden in de connector). |
| `hiringOrganization.name` | `opdrachtgeverNaam` | Samplewaarde `TenMonks`; geen eindklant afgeleid. |
| `baseSalary` | `tarief` | Shared normaliser promoot EUR/MONTH `3824`–`5624` als maandband. |
| `jobLocation.address.addressLocality` | `locatieTekst` | Samplewaarde `Noord-Holland`. |
| `validThrough` | sluitingsmoment | Samplewaarde `2027-01-01T00:00:00+00:00`. |

## Ingest-patroon

- Lees alleen `assignment-sitemap1.xml` en accepteer detail-URL's in de vorm
  `/opdrachten/<digits>/<slug>/`.
- Respecteer een crawl-delay van 2 seconden.
- Er is in de sample geen betrouwbaar label/value-blok; mapping is JSON-LD-only.
- Het publieke WordPress REST API-pad voor de opdracht-CPT's gaf 404; sitemap
  discovery is daarom de primaire route.

## Robots en voorwaarden

`https://tenmonks.nl/robots.txt` blokkeert `/wp-admin/` en de WPForms-uploadmap,
maar laat de overige site toe en verwijst naar `sitemap_index.xml`. De robotsfile
bevat geen crawlverbod voor opdrachten. De AVG-geautomatiseerde-besluitvorming-
tekst is geen crawlverbod; `voorwaardenStatus` blijft **`te_toetsen`** vóór
activatie.

## Voorwaarden

- robots.txt: tenmonks.nl: HTTP 200, geen Disallow op connectorpaden (/, /opdrachten/34350/data-analist/), geprobed 2026-09-25
- ToS/gebruiksvoorwaarden: zie "Robots en voorwaarden" hierboven
- Besluit: `te_toetsen`
- Besluitnemer en datum: open voor Robbie (geen besluit vastgelegd)

## Overlap, deduplicatie en known hashes

TenMonks is geen **ALIAS** van Opdrachtoverheid; het is een peer broker naast
Bij Oranje, TenTalent, Hero en Pro-Act. Inhoudelijke overlap kan voorkomen,
maar normale identity-deduplicatie moet die behandelen.

`listingHashCoversDetail: false`: de sitemap-hash ziet alleen de URL, terwijl de
relevante JobPosting-velden op de detailpagina staan. Daarom wordt de
known-hash-store niet doorgestuurd (RJC-357/RJC-401).
