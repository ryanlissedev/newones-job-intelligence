# Techniekwerkt — ingest-recept

Status: **connector toegevoegd** — adapter-categorie `json-ld` met
`detailSynthesizer` (CTP-551).

## Endpoints

| Doel | URL | Opmerking |
|---|---|---|
| Sitemap | `GET https://media.techniekwerkt.nl/sitemaps/vacatures.xml.gz` | 8.245 vacature-URL's (opname 2026-09-17), allemaal `https://techniekwerkt.nl/nl/vacature/<slug>-<id>`; gzip-compressed (`application/x-compressed`, géén `Content-Encoding`) — de gedeelde live-reader decomprimeert op magic bytes. |
| Detail | `https://techniekwerkt.nl/nl/vacature/<slug>-<id>` | Geen JobPosting JSON-LD (alleen `BreadcrumbList`). De vacature zit gestructureerd in `<script id="vike_pageContext" type="application/json">` onder `pageProps.job`. |

## Correctie op de Wave-1B-inventaris

De eerdere probe (CTP-551, `docs/sources/inventory/boards-wave1b.md`) verbaalde
NO-JSONLD en "geen in-page state" omdat ze alleen naar
`__NEXT_DATA__`/`__NUXT__`/microdata keek. Het Vike `pageContext`-script zit er
wél — live capture wint; het verdict is hiermee gecorrigeerd naar buildbaar via
framework-state-synthesis (dezelfde route als ASML's `__NEXT_DATA__`).

## Veldmapping en datakwaliteit

| `pageProps.job` | Canoniek | Provenance/noot |
|---|---|---|
| `original_functiontitle` | `title` → titel | Letterlijk. |
| `description` | beschrijving | HTML, letterlijk. |
| `original_companyname` | `hiringOrganization.name` → opdrachtgeverNaam | Werkgever die de vacature plaatste (bv. `Unica`). |
| `city` | `jobLocation.address.addressLocality` → locatieTekst | `addressCountry` `NL` — het is een NL-board. |
| `id` | `identifier` + `labelBlock.referentienummer` | Numeriek job-id. |
| `updated_at` | `labelBlock.gewijzigdOp` | Laatste wijziging, géén publicatiedatum — `publicatiedatum` blijft UNKNOWN. |
| `industry` / `experience` / `education` / `contract` / `salary` namen | `labelBlock.branche` / `ervaring` / `opleiding` / `dienstverband` / `salaris` | Alleen wanneer de bron ze vult; `salary` en `contract` waren leeg op alle vier gesamplede pagina's (2026-09-17) en mappen nooit naar `tarief`/`employmentType` — de vorm is ongeverifieerd. |
| `apply_email`, `contact_name`, `contact_phone_number` | — niet overgenomen | Contact-PII wordt geminimaliseerd (DEC-008); fixtures zijn mechanisch geredacteerd. |

De sitemap bevat uitsluitend URL-metadata. Daarom is `listingHashCoversDetail:
false` en worden known hashes niet doorgestuurd. `crawlDelayMs` is 2000 en
`voorwaardenStatus` blijft `te_toetsen`: robots staat discovery toe (alleen
`/*ad-click/`, `/*apply-redirect/`, `/*solliciteren/`, `/cdn-cgi/` en
`/*page=*` disallowed). De drie vastgelegde detailpagina's zijn echte
HTTP-opnames; strips zijn uitsluitend mechanisch (scripts behalve
`ld+json`/`vike_pageContext`, style, svg, nav) en contact-e-mail/telefoon is
geredacteerd.

## Voorwaarden

- robots.txt: media.techniekwerkt.nl: HTTP 200, geen Disallow op connectorpaden (/sitemaps/, /nl/vacature/), geprobed 2026-09-25
- ToS/gebruiksvoorwaarden: niet gevonden
- Besluit: `te_toetsen`
- Besluitnemer en datum: open voor Robbie (geen besluit vastgelegd)
