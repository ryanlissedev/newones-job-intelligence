# Essent — ingest-recept

Status: **connector toegevoegd** — adapter-categorie `json-ld` met
`detailSynthesizer` (CTP-563, gecorrigeerd 2026-09-30).

## Endpoints

| Doel | URL | Opmerking |
|---|---|---|
| Sitemap | `GET https://www.werkenbijessent.nl/sitemap.xml` | 175 URL's waarvan ~30 vacatures in de vorm `/nl/vacatures/<vakgebied>/<slug>` — inclusief een letterlijke `vacatures`-categorie (`/nl/vacatures/vacatures/<slug>`). Alleen twee-segment-vormen worden gevolgd. |
| Detail | `https://www.werkenbijessent.nl/nl/vacatures/<vakgebied>/<slug>` | Kentico-SSR. Geen JobPosting JSON-LD; vacature-metadata zit in een `data:text/javascript;base64`-script met een Vue `DataItems`-lijst (`{CssClass: field|salary|location|calendar, Value: "…"}`), plus `og:`/`article:`-meta's en een `.content`-introblok + `vacItem`-secties. |

## Correctie op het eerdere verdict

De inventaris (CTP-563) markeerde de bron onbereikbaar: elk request gaf vanaf
onze egress stalls / `302 → /Error.htm` / `500` (WAF-achtig). De her-probe van
2026-09-30 slaagde gewoon — robots adverteert de sitemap en detailpagina's
leveren de volledige DataItems-payload. Verdict gecorrigeerd naar buildbaar.

## Veldmapping en datakwaliteit

| Bron | Canoniek | Provenance/noot |
|---|---|---|
| `<h1>` | `title` → titel | `og:title` is fallback: sommige pagina's dragen het site-patroon "Vacatures - &lt;titel&gt; - Werken bij Essent" (bv. financial-controller). |
| `.content`-blok + `vacItem`-secties | `description` → beschrijving | HTML, letterlijk, sectiekoppen als `<h3>`. |
| `article:published_time` | `datePosted` → publicatiedatum | Kentico-datum, verbatim (`2026-09-01T00:00:00.0000000`). |
| `DataItems.location` | `jobLocation.address.addressLocality` + `labelBlock.locatie` | Kan meerdere plaatsen bevatten ("Utrecht  / 's-Hertogenbosch"). |
| `DataItems.calendar` | `labelBlock.urenPerWeek` → uren_per_week | "36 - 40 uur" → `36–40`. |
| `DataItems.salary` | `labelBlock.salaris` | Maandrange van een vaste functie → nooit `tarief`/`baseSalary`. |
| `DataItems.field` | `labelBlock.vakgebied` | Vakgebied-label. |
| URL-slug | `identifier` + `labelBlock.referentienummer` | Er is geen numeriek vacature-id; de slug is de bronreferentie. |
| — | sluitingsdatum, dienstverband | Niet gepubliceerd; blijft UNKNOWN. |

De sitemap bevat uitsluitend URL-metadata. Daarom is `listingHashCoversDetail:
false` en worden known hashes niet doorgestuurd. `crawlDelayMs` is 2000 en
`voorwaardenStatus` blijft `te_toetsen`: robots disallowed alleen
CMS-paden (`/Admin/`, `/bin/` e.a.). De vijf vastgelegde detailpagina's zijn
echte HTTP-opnames; strips zijn mechanisch (`--no-defaults`, alleen scripts
zonder `data:`-src plus style/svg/nav/footer) en contact-telefoonnummers zijn
geredacteerd.

## Voorwaarden

- robots.txt: www.werkenbijessent.nl: HTTP 200, geen Disallow op connectorpaden (/, /nl/vacatures/customer-services/, /nl/vacatures/engineering/, /nl/vacatures/vacatures/), geprobed 2026-09-25
- ToS/gebruiksvoorwaarden: niet gevonden
- Besluit: `te_toetsen`
- Besluitnemer en datum: open voor Robbie (geen besluit vastgelegd)
