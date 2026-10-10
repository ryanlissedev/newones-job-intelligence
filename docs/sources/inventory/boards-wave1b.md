# Wave 1 · Lane B — board-inventaris (CTP-586, CTP-576, CTP-550, CTP-551, CTP-553, CTP-582)

Onderzoek 2026-09-17 UTC, read-only met `curl`/webfetch (declared bot-UA), geen
logins, geen omzeiling. ToS/robots-probe vóór connectorbesluit, per de
lane-instructie "Boards met ToS-probe eerst, dan connector".

**Verdict-legenda:** BUILD (connector gebouwd in deze lane) · DROP-ROBOTS ·
DROP-AGGREGATOR · NO-JSONLD (public, maar geen machineleesbare vacaturedata).

## Verdict-tabel

| Issue | Bron | Verdict | Bewijs |
|---|---|---|---|
| CTP-586 | ICTerGezocht | **DROP-ROBOTS** | Geen sitemap (`/sitemap.xml` → 404.php). Alle discovery-paden disallowed: `/*search=`, `/*page=`, `/*what=`, `/*where=`. Detailpaden wel toegestaan maar zonder compliant listing-route is er niets te ontdekken. |
| CTP-576 | Freelance.nl | **DROP-ROBOTS** | `User-agent: *` / `Disallow: /` — alle niet-naamgenoemde bots volledig geblokkeerd. Alleen Googlebot/Bing/e.a. op de whitelist. Sitemap bestaat maar valt onder dezelfde uitsluiting. |
| CTP-550 | Intermediair | **BUILD** | `sitemap-index` `cdn/sitemaps/vacature.xml` → 1 child, hourly refresh, 2.480 vacature-URL's; detailpagina's dragen JobPosting JSON-LD. Connector `intermediair` toegevoegd (bronId `…0037`). Zie `docs/sources/intermediair.md`. |
| CTP-551 | Techniekwerkt | **NO-JSONLD → gecorrigeerd BUILD** | Vacature-sitemap `media.techniekwerkt.nl/sitemaps/vacatures.xml.gz` live met detail-URL's. Detailpagina's dragen alleen `BreadcrumbList` JSON-LD — géén JobPosting — maar wél in-page state: `vike_pageContext.pageProps.job` (gemist in deze probe; zie `docs/sources/techniekwerkt.md`). Connector `techniekwerkt` gebouwd via `detailSynthesizer`. |
| CTP-553 | Jooble | **DROP-AGGREGATOR** | Sitemap-index `nl.jooble.org/sitemap.xml` met 41 shards `/jdp/<id>`-details, crawlbaar. Maar Jooble is een meta-aggregator: dezelfde vacatures staan al op de eerste-partij-bronnen. Toevoegen zou alleen duplicaten leveren; niet gebouwd. |
| CTP-582 | Planet Interim | **BUILD** | `/opdrachten` publiek (200), detailpaden `/<slug>/<id>/p<cat>/default.html` met JobPosting JSON-LD; robots.txt zonder Disallow. Paginering is ASP.NET-postback (niet crawlbaar) → listing-discovery op de nieuwste pagina. Connector `planet-interim` toegevoegd (bronId `…0038`). Zie `docs/sources/planet-interim.md`. |

## Bewijs per bron

### CTP-586 ICTerGezocht

- `robots.txt` → 200: lange Disallow-lijst; `/*search=`, `/*page=`, `/*what=`, `/*where=` expliciet uitgesloten voor `User-agent: *`.
- `sitemap.xml` en `sitemap_index.xml` → 301 naar `/pages/misc/404.php`.
- Zonder sitemap en met alle listing-params disallowed is er geen compliant
  discovery-route. Detailpaden (`/vacature/…`) zijn op zichzelf toegestaan.

### CTP-576 Freelance.nl

- `robots.txt` → 200: naamgenoemde bots (Googlebot, Bing, GPTBot, ClaudeBot,
  PerplexityBot, e.a.) mogen gedeeltes; `User-agent: *` krijgt `Disallow: /`.
- `Sitemap: https://www.freelance.nl/sitemaps/sitemap.xml` staat er wel, maar
  de wildcard-uitsluiting geldt ook daar.
- Een generieke poller is per definitie `*`-bot → geen compliant route.

### CTP-550 Intermediair

- `robots.txt` → 200: `/vacature/zoeken?*`, `/vacatures/*?*page=` en
  account/sollicitatie-paden disallowed; detailpaden en de gepubliceerde
  sitemaps niet. `ClaudeBot` expliciet `Disallow: /`.
- Sitemap-index `https://www.intermediair.nl/cdn/sitemaps/vacature.xml` → 200:
  één child `vacature-1.xml` (lastmod hourly), 432 kB, 2.480
  `/vacature/<uuid>/<slug>`-URL's.
- Detailprobe → 200 met `application/ld+json` `@type: JobPosting`
  (title/jobLocation/datePosted/validThrough/employmentType; `baseSalary`
  deels `null`).
- DPG Media privacy-poort: browser-UA's krijgen een consent-redirect naar
  `myprivacy.dpgmedia.nl`; een declared bot-UA krijgt de pagina direct. Zie
  het bron-recept voor de live-implicatie.

### CTP-551 Techniekwerkt

- `robots.txt` → 200: alleen `/*ad-click/`, `/*apply-redirect/`,
  `/*solliciteren/`, `/cdn-cgi/`, `/*page=*` disallowed; sitemap-index
  gepubliceerd.
- `media.techniekwerkt.nl/sitemaps/vacatures.xml.gz` → 200 met
  `/nl/vacature/<slug>-<id>`-URL's (dagelijkse changefreq).
- Detailprobe → 200, 165 kB SSR-HTML; enige JSON-LD is `BreadcrumbList`.
  Vacaturevelden (o.a. salaris) zitten als vrije tekst in de body. Geen
  `__NEXT_DATA__`/`__NUXT__`/microdata.
- Verdict: publiek maar niet machine-leesbaar via JSON-LD → NO-JSONLD,
  html-adapter-kandidaat, consistent met Waternet (CTP-579).

### CTP-553 Jooble

- `robots.txt` → 200: `/SearchResult`, `/desc/`, click/redirect-paden
  disallowed; `/jdp/`-details niet uitgesloten; sitemap-index gepubliceerd.
- `nl.jooble.org/sitemap.xml` → 200: 41 shards
  `sitemap_tree_jdp_nl_NL_*.xml` met `/jdp/<id>`-URL's.
- Technisch bouwbaar, maar inhoudelijk een aggregator die dezelfde vacatures
  van eerste-partij-bronnen dupliceert → DROP op datakwaliteit, niet op ToS.

### CTP-582 Planet Interim

- `robots.txt` → 200: alleen EU-TDM-content-signal-preambule; geen
  `User-agent`/`Disallow`-regels.
- `/sitemap.xml` → 404 (IIS 404-pagina).
- `/opdrachten` → 200, publiek, met 20 detail-links
  `/<slug>/<id>/p<cat>/default.html`; paginering via
  `WebForm_DoPostBackWithOptions` (postback, niet crawlbaar).
- Detailprobe → 200 met `application/ld+json` `@type: JobPosting`
  (title/jobLocation/datePosted/validThrough; `employmentType: CONTRACTOR`;
  `baseSalary` min/max = 0 → tarief afwezig bij de bron).
