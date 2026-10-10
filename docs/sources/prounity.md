# ProUnity — ingest-recept (geverifieerd 2026-09-18)

Status: **connector gebouwd** — adapter-categorie `html` (SSR-scrape, géén JobPosting JSON-LD). Belgische freelance-missies van HeadFirst Group (pro-unity.com, WordPress/Avada + Weglot). BE-scope is expliciet GO gegeven door de product owner (CTP-543); de missies zijn ~100 % België.

## Endpoints

| Doel | URL | Opmerking |
|---|---|---|
| Sitemap-index | `GET https://www.pro-unity.com/sitemap.xml` | AIOSEO-index met o.a. `post-`, `page-` en `pji_job-sitemap*.xml` children. |
| Job-sitemaps | `GET https://www.pro-unity.com/pji_job-sitemap{,2,3,4,5}.xml` | `<url>`-entries zijn `/job/<uuid>/` — inclusief historie (±4.800 URL's totaal; chunk 1 telt 1.000, chunk 5 telt 833). Nieuwste chunk = `pji_job-sitemap.xml` (eigen lastmod 2026-09-17). |
| Detail | `GET https://www.pro-unity.com/job/<uuid>/` | SSR; **geen JobPosting JSON-LD** (alleen `BreadcrumbList`/`Organization`/`WebPage`/`WebSite` — geverifieerd live). Ook geen `__NEXT_DATA__`/Vike-state → HTML-extractie. |
| Listing | `GET https://www.pro-unity.com/freelance-missions/` | ±45 open missies server-rendered; **alle 45 zitten in de nieuwste pji_job-chunk** (geverifieerd 2026-09-18). Wordt niet gescraped — sitemap is de discovery-route. |

## Veldmapping → canoniek `aanvraag`

| ProUnity | Canoniek | Provenance/noot |
|---|---|---|
| `h2.fusion-post-title` | `titel` | Bijv. "Frontend Web Developer (K10127)". |
| `(K\d+)` in titel | `bronSpecifiek.referentie` | Mission-code; geen bronReferentie (dat is de uuid). |
| `span.putag` | `bronSpecifiek.duur` | "2 months"; **afwezig op historische pagina's**. |
| `.job__infobar` span 1 | `startDatum` + `bronSpecifiek.eind_datum`/`periode` | Positioneel (geen labels): `"12/10/2026 - 31/12/2026"` (dd/mm/yyyy) — het werkvenster van de missie. |
| `.job__infobar` span 2 | `locatieTekst` (+ `locatieLand` = `BE`) | Land, geen stad ("Belgium" op alle bemonsterde pagina's). |
| `.job h6` + `.tags li` | `bronSpecifiek.rollen`/`talen`/`skills` | Secties Roles/Languages/Skills; elke `<li>` = `<b>naam</b>` + `span.tag2` status ("Confirmed", "Active knowledge"). |
| `div.richtext` | `beschrijving` | Opgeslagen als `raw.html` (gesanitiseerd); clientnaam staat alleen ín deze proza → `opdrachtgeverNaam` = UNKNOWN, nooit gemined. |
| `a.job__signin` | `bronSpecifiek.sollicitatie_url` | `platform.pro-unity.com` "Sign in to apply". |
| `/job/<uuid>/` | `bronReferentie` + `bronUrl` | uuid uit de sitemap-URL. |

Afwezig bij de bron (blijft UNKNOWN, nooit gegokt): **tarief** (nergens gerenderd), **sollicitatiedeadline** (zie hieronder), **uren/week**, **opdrachtgever** (alleen in proza).

## Ingest-patroon

- `discover()` haalt de sitemap-index op en volgt álle `pji_job`-children (5 stuks; de index deelt ze niet in op open/gesloten) → één pass, `hasMore: false`.
- `fetch()` per `/job/<uuid>/` detailpagina; `listingHashCoversDetail: false`.
- Historische missies renderen gewoon 200 met "Sign in to apply" — er is **geen closed-marker**; de verstreken periode is het enige sluitingssignaal (zie hieronder).
- Volume: ±4.800 detail-URL's (grotendeels historie). Bij `Crawl-delay: 10` is een volledige live-poll traag; eventuele barking/beperking is een productbeslissing, niet in de connector gebakken.

## Licentie en voorwaarden

- `robots.txt`: WooCommerce-disallows + **`Crawl-delay: 10`** (seed `crawlDelayMs: 10_000`) + `Sitemap: /sitemap.xml`. Geen disallow op `/job/` of de sitemaps.
- ToS (`/terms-of-use/`, geverifieerd 2026-09-18): *"the User shall not itself or allow a third party to copy, analyze, decompile, make public, distribute, transfer to third parties, or change any content encumbered with Intellectual Property Rights unless expressly permitted by ProUnity."* De IP-definitie omvat expliciet *"rights relating to databases"* → IP/databankclausule raakt mogelijk het overnemen van de missie-index. Geen expliciete scraping/robotsclausule verder.
- **`voorwaardenStatus: "te_toetsen"`** — de GO geldt de BE-scope; de IP/databankclausule blijft te toetsen (HeadFirst-relatie via Striive/Inhuurdesk benutten voor expliciete toestemming).

## Voorwaarden

- robots.txt: www.pro-unity.com: HTTP 200, geen Disallow op connectorpaden (/), Crawl-delay 10, geprobed 2026-09-25
- ToS/gebruiksvoorwaarden: zie "Licentie en voorwaarden" hierboven
- Besluit: `te_toetsen`
- Besluitnemer en datum: open voor Robbie (geen besluit vastgelegd)

## Sluitingsdatum

ProUnity publiceert geen sollicitatiedeadline. Het enige sluitingssignaal op de detailpagina is het eigen werkvenster: een missie waarvan de periode is verstreken (de 2023-historie) kan onmogelijk nog open staan → het **periode-einde** voedt `sluitingsdatum` als ondergrens van sluiting (`closingMomentInstant`, Europe/Amsterdam ≡ Europe/Brussels). Open missies (einddatum in de toekomst) blijven `active`; historische missies worden `closed`.

## Risico's

1. `.job__infobar`-velden zijn positioneel (geen labels) — bij een andere volgorde parsen periode/land verwisseld; bevestigd op 3 pagina's (2 open, 1 historisch), allemaal `["<periode>", "Belgium"]`.
2. Sectie-headingsteksten zijn Engels ("Roles"/"Languages"/"Skills"); Weglot kan andere locales serveren — onbekende h6-tekst laat de sectie leeg (geen foute attributie).
3. Volume ±4.800 URL's inclusief historie → lange live-runs bij crawl-delay 10.
4. ToS IP/databankclausule ongetoetst → `te_toetsen`.

## Known-hash short-circuit (RJC-357 / RJC-401)

`listingHashCoversDetail: false` — de sitemap-rij (`url` + `lastmod`) ziet de detailpagina niet; daar leven titel/periode/requirements/beschrijving. Geen `knownHashes`-store doorgegeven (afgedwongen in `sources.spec.ts`).

## Fixtures

- `prounity/listing-page-0.json` — sitemap-index (alle 5 `pji_job`-children bewaard; fixture-modus slaat children zonder opgenomen sitemap-fixture over).
- `prounity/sitemap-pji-job.json` — nieuwste child, mechanisch getrimd tot de 2 URL's met een detail-fixture (CDATA `<loc>`: `tools/fixtures/trim-sitemap.ts` matcht plain `<loc>`, voor CDATA is dezelfde regel handmatig toegepast — zie captureNote).
- `prounity/detail-2d7d21bd-….json` — open missie (Frontend Web Developer, K10127).
- `prounity/detail-0e8d62af-….json` — tweede open missie (Data Scientist, K10126; infobar-volgorde bevestigd).
- `prounity/detail-3469b088-….json` — historische missie 2023 (geen `putag`, verstreken periode, geen closed-marker).
