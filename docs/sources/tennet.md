# TenneT — ingest-recept

Status: **connector toegevoegd** — adapter-categorie `json-ld` met
`detailSynthesizer` (CTP-557, gecorrigeerd 2026-09-30).

## Endpoints

| Doel | URL | Opmerking |
|---|---|---|
| Sitemap | `GET https://careers.tennet.eu/nl_NL/careers/sitemap.xml` | NL-kind van `careers/sitemap_index.xml` (robots-geadverteerd). 189 URL's waarvan 142 vacature-details `/nl_NL/careers/JobDetail/<slug>/<nummer>` (opname 2026-09-30); de rest zijn utility-pagina's (SearchJobs, JobAlert e.d.). |
| Detail | `https://careers.tennet.eu/nl_NL/careers/JobDetail/<slug>/<nummer>` | Avature-SSR, narratieve artikelen. Geen JobPosting JSON-LD en géén veldlijst: titel in `og:title`, job-id in `og:url` (`jobId=`) resp. het URL-suffix, beschrijving in `article--details`-blokken. |

## Correctie op het eerdere verdict

De inventaris (CTP-557) verbaalde NO-JSONLD omdat `werkenbij.tennet.eu` toen
onbereikbaar was en het careers-domein niet was geprobeerd. `careers.tennet.eu`
is bereikbaar en publiek — verdict gecorrigeerd naar buildbaar via
Avature-synthesis.

## Veldmapping en datakwaliteit

| Bron | Canoniek | Provenance/noot |
|---|---|---|
| `og:title` | `title` → titel | Entities gedecodeerd (`&amp;` → `&`). |
| `article--details`-blokken | `description` → beschrijving | HTML, aaneengeschakeld; sectiekoppen blijven in de markup. |
| `og:url` `jobId=` / URL-suffix | `identifier` + `labelBlock.referentienummer` | Numeriek Avature-job-id. |
| — | locatieTekst | **Niet gepubliceerd op de detailpagina.** De SearchJobs-kaartjes tonen wel een plaats, maar die zit niet in de detailmarkup → locatie blijft eerlijk UNKNOWN; niets wordt uit slug of prosa afgeleid. |
| — | publicatiedatum, sluitingsdatum, uren, dienstverband, tarief | Niet gepubliceerd; blijft UNKNOWN. |
| `hiringOrganization` | opdrachtgeverNaam | `TenneT` — enige redactie-optie is uitschakelen van de bron. |

De sitemap bevat uitsluitend URL-metadata. Daarom is `listingHashCoversDetail:
false` en worden known hashes niet doorgestuurd. `crawlDelayMs` is 2000 en
`voorwaardenStatus` blijft `te_toetsen`: robots `Allow`'t de careers-portals
expliciet en disallowed alleen `*qtvc=`-queryvarianten. De drie vastgelegde
detailpagina's zijn echte HTTP-opnames; strips zijn mechanisch (defaults +
`img`, dat ~250KB base64-JPEG's droeg) en contact-e-mails zijn geredacteerd.

## Voorwaarden

- robots.txt: careers.tennet.eu: HTTP 200, geen Disallow op connectorpaden (/nl_NL/careers/, /nl_NL/careers/JobDetail/Operating-Engineer-Electrical-Auxiliary-Automation-Expat-EU-Resident-Malaysia-Johor-Bahru/, /nl_NL/careers/JobDetail/Power-System-EMT-Specialist/, /nl_NL/careers/JobDetail/Toezichthouder-Transmission-Lines-Brabant/), geprobed 2026-09-25
- ToS/gebruiksvoorwaarden: niet gevonden
- Besluit: `te_toetsen`
- Besluitnemer en datum: open voor Robbie (geen besluit vastgelegd)
