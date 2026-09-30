# Planet Interim (planetinterim.nl) — ingest-recept

Status: **bounded pagination toegevoegd; productie-egress geblokkeerd** — JSON-LD listing-discovery (CTP-582/620).

## Endpoints

| Doel | URL |
|---|---|
| Listing | `https://planetinterim.nl/opdrachten` |
| Detail | `https://planetinterim.nl/<slug>/<id>/p<cat>/default.html` |

## Discovery

`kind: "listing"` op `/opdrachten`, `linkPattern`
`^/[a-z0-9-]+/\d+/p\d+/default\.html$`. Een listingpagina toont 20 opdrachten;
de volgende pagina gebruikt een ASP.NET-WebForms-postback
(`WebForm_DoPostBackWithOptions`) met cookies en hidden state en is niet via GET
crawlbaar. De Planet-specifieke client bewaart die sessiestaat, post de
`nextPostbackButton` sequentieel en stopt bij een disabled/ontbrekende next-knop.
De client heeft een harde limiet van 50 pagina's en faalt gesloten bij een
herhaalde pagina, malformed HTML of een block page. De actuele lokale probe
(2026-09-19T14:55:09.976Z–2026-09-19T14:55:16.069Z) liep 26 pagina's door: 25
pagina's met 20 URLs en een laatste pagina met 10 URLs (510 unieke
detail-URLs). De echte, mechanisch gestrippte first/next/last-responses staan
als `pagination-first.json`, `pagination-next.json` en `pagination-last.json`
onder `fixtures/connectors/planet-interim/`; hun `capturedAt` komt van de
raw-file mtime. Deze bounded diagnose gebruikte `pageDelayMs=0`; de connector
gebruikt standaard 2 seconden tussen POSTs.

Dit bewijst de publieke route vanaf de probe-host. De operator-probe vanaf de
productiebox op 2026-09-19T14:31:24Z kreeg HTTP 403 op listing en detail (robots
bleef 200). Productie-ingest blijft daarom geblokkeerd tot provider-toegang,
allowlisting of een aantoonbaar werkende geautoriseerde egress/feed beschikbaar
is; geen `PLANET_INTERIM_LIVE=1` activeren vóór die egress-gate.

`JsonLdClient.fetchListing(signal)` geeft het abortsignaal van de connector-run
door aan de pager. Het signaal begrenst zowel de lopende HTTP-aanvraag en het
lezen van de responsebody als het wachten tussen pagina's. De regressietests
dekken annulering vóór de aanvraag, tijdens een lopende listing-fetch en
tijdens de wachttijd; de gedeelde HTTP-timeout begrenst ook een vastlopende body.

Er is geen sitemap (`/sitemap.xml`, `/sitemap_index.xml` en `/sitemap` → 404)
en de gecontroleerde Atom/feed-routes (`/opdrachten/atom.xml`, `/atom.xml`,
`/feed`) geven 404. `robots.txt` gaf 200 zonder `Disallow` en zonder Sitemap-
verwijzing.

## Veldmapping → canoniek `aanvraag`

| JSON-LD | Canoniek | Noot |
|---|---|---|
| `title` | `titel` | Letterlijk. |
| `description` | `beschrijving` | HTML in de bron. |
| `hiringOrganization.name` | `opdrachtgeverNaam` | Altijd `Planet Interim` (direct-sourcing marketplace, Matchd/ZiPconomy). |
| `jobLocation.address.addressLocality` | `locatieTekst` | `postalCode` is letterlijk `niet vermeld`. |
| `datePosted` | `bronSpecifiek.publicatiedatum` | Datum zonder tijd. |
| `validThrough` | `sluitingsdatum` | Aanwezig op alle samples. |
| `employmentType` | `bronSpecifiek.contract_type` | `CONTRACTOR`. |
| `baseSalary` | UNKNOWN | `MonetaryAmount` aanwezig maar `minValue`/`maxValue` = `0` (bron publiceert geen tarief). |

## Robots, voorwaarden en fixtures

`robots.txt` bevat geen `Disallow`-regels; het bestand bevat alleen de
EU-TDM-content-signal-preambule zonder signaalwaarden (geen verlening, geen
beperking via robots) → `voorwaardenStatus: te_toetsen`, `crawlDelayMs` 2000,
`listingHashCoversDetail: false`. Geen consent- of WAF-poort waargenomen.

Fixtures: `tools/fixtures/record.ts`, standaardstrips. Op de detailpagina's
staan recruiter-contactgegevens; e-mail is mechanisch geredigeerd.

## Voorwaarden

- robots.txt: planetinterim.nl: HTTP 200, geen Disallow op connectorpaden (/, /beleidsadviseur-informatisering-ciso-bu/538233/p13/, /data-regisseur-bi-specialist/538587/p13/, /informatiemanager-crisisbeheersing/538704/p13/), geprobed 2026-09-25
- ToS/gebruiksvoorwaarden: zie "Robots, voorwaarden en fixtures" hierboven
- Besluit: `te_toetsen`
- Besluitnemer en datum: open voor Robbie (geen besluit vastgelegd)
