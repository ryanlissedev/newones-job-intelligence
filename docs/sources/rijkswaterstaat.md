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

## Voorwaarden

- robots.txt: werkenbij.rijkswaterstaat.nl: HTTP 200, geen Disallow op connectorpaden (/, /vacatures/adviseur-assetmanagement-rivierbodem/, /vacatures/adviseur-waterveiligheid/, /vacatures/jurist-handhaving/), geprobed 2026-09-25
- ToS/gebruiksvoorwaarden: niet gevonden
- Besluit: `te_toetsen`
- Besluitnemer en datum: open voor Robbie (geen besluit vastgelegd)
