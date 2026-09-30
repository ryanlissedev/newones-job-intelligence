# Enexis — ingest-recept

Status: **probe afgerond; connector toegevoegd** — adapter-categorie `json-ld`.

## Endpoints

| Doel | URL | Opmerking |
|---|---|---|
| Sitemap | `GET https://werkenbij.enexis.nl/sitemap.xml` | 170 vacature-URLs (opname 2026-09-17) in de vorm `/vacatures/<slug>-<nummer>`; overige pagina's worden uitgesloten. |
| Detail | `https://werkenbij.enexis.nl/vacatures/<slug>-<nummer>` | Detailpagina met JobPosting JSON-LD en daarnaast een BreadcrumbList-node. |

## Veldmapping en datakwaliteit

| JSON-LD | Canoniek | Provenance/noot |
|---|---|---|
| `title`, `description` | titel, beschrijving | Detailpagina, letterlijk. |
| URL-pad | `bronReferentie`, `bronUrl` | De `url`-property in het JobPosting-node is leeg aan de bron; de connector gebruikt daarom de opgevraagde detail-URL voor bronreferentie en bron-URL. |
| `datePosted` | `bronSpecifiek.publicatiedatum` | Letterlijk overgenomen. |
| `hiringOrganization.name` | `opdrachtgeverNaam` | `Enexis Netbeheer B.V.`. |
| `jobLocation.address.addressLocality` | `locatieTekst` | Detailpagina; `addressCountry` is `NL`. |
| `baseSalary.value` | `tarief` | Letterlijk `MONTH`, met EUR-minimum en -maximum. De normaliser zet dit om naar een maandbedrag zonder jaarbedragen te infereren. |
| `validThrough` | `sluitingsdatum` | Niet gepubliceerd; blijft UNKNOWN. |
| `employmentType` | `bronSpecifiek.contract_type` | Niet gepubliceerd; blijft UNKNOWN. |

De sitemap bevat URL- en lastmod-metadata, maar geen detailvelden. Daarom is
`listingHashCoversDetail: false` en worden known hashes niet doorgestuurd.
`crawlDelayMs` is 2000 en `voorwaardenStatus` blijft `te_toetsen`: robots staat
toegang toe en de disclaimer bevat geen scraping-clausule. De drie vastgelegde
detailpagina's zijn echte HTTP-opnames; XML/HTML-strips zijn uitsluitend
mechanisch uitgevoerd. Recruitercontactblokken zijn uit de fixtures verwijderd;
de JobPosting-beschrijvingen zelf bevatten in deze samples geen recruitercontact.

## Voorwaarden

- robots.txt: werkenbij.enexis.nl: HTTP 200, geen Disallow op connectorpaden (/, /vacatures/), geprobed 2026-09-25
- ToS/gebruiksvoorwaarden: niet gevonden
- Besluit: `te_toetsen`
- Besluitnemer en datum: open voor Robbie (geen besluit vastgelegd)
