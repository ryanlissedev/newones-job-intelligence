# Circle8 — ingest-recept

Status: **probe afgerond; connector toegevoegd** — adapter-categorie `json-ld`
(CTP-541). Circle8 is een detacheerder/broker met een eigen Teamtailor-
carrièreportal (`werkenbij.circle8.nl`).

## Wat de bron wel en niet publiceert

De Linear-issue noemt "klantopdrachten". Live-verificatie (2026-09-18, NL IP):
de `/jobs`-listing bevat **uitsluitend interne Circle8-vacatures** — op het
moment van opname twee stuks (IT Recruiter, Bedrijfsjurist), beide in
Nieuwegein. Er staat geen enkele klantopdracht op dit portal; `hiringOrganization`
is dan ook de werkgever zelf ("Circle8"), geen broker-front. Als Circle8 later
klantopdrachten op dit portal plaatst, komen ze via hetzelfde
`/jobs/<id>-<slug>`-patroon binnen — de connector hoeft daarvoor niet te
veranderen.

## Endpoints

| Doel | URL | Opmerking |
|---|---|---|
| Listing | `GET https://werkenbij.circle8.nl/jobs` | Teamtailor-overzichtspagina; rendert alle vacatures als `/jobs/<id>-<slug>`-anchors (2 vacatures, "2 vacatures"-teller op de pagina). |
| RSS | `GET https://werkenbij.circle8.nl/jobs.rss` | Alternatieve feed met dezelfde 2 items; niet gebruikt — de HTML-listing is de geverifieerde route. |
| Detail | `https://werkenbij.circle8.nl/jobs/<id>-<slug>` | Teamtailor-detailpagina met `application/ld+json` JobPosting-node. |
| Sitemap | `GET https://werkenbij.circle8.nl/sitemap.xml` | 164 entries, grotendeels `/people/*` (127) en `/posts/*` (27); de listing is schoner dan whitelist-filtering hierop. |

## Discovery en veldmapping

`discovery.kind: "listing"` op `/jobs` met `linkPattern /^\/jobs\/\d+-[^/?#]+$/`.
De sitemap is bewust niet de discovery-bron: hij bestaat voor ~90% uit
`/people`- en `/posts`-URL's en biedt niets dat de listing niet ook heeft.

| Circle8 (JSON-LD/detail) | Canoniek | Provenance/noot |
|---|---|---|
| `title` | `titel` | Letterlijk overgenomen. |
| `description` | `beschrijving` | Entity-encoded HTML in de ld+json-node. |
| URL-pad | `bronReferentie` | `jobs/<id>-<slug>`; `<id>` is het Teamtailor-jobid. |
| `identifier.value` | `bronSpecifiek.identifier` | `"8338072"` etc., `name: Circle8`. |
| `datePosted` | `bronSpecifiek.publicatiedatum` | Volledige ISO-timestamp met +02:00-offset. |
| `employmentType` | `bronSpecifiek.contract_type` | `"FULL_TIME"` — beschrijft dienstverband, geen contractvorm; `contracttype` blijft null (gedeelde mapping laat FULL_TIME/PART_TIME bewust ongemapt). |
| `hiringOrganization.name` | `opdrachtgeverNaam` | `"Circle8"` — interne vacature, werkgever = opdrachtgever. |
| `jobLocation[0].address.addressLocality` | `locatieTekst` | `"Nieuwegein"`. |
| `jobLocation.address.addressRegion` | `bronSpecifiek.provincie` | `null` gepubliceerd → provincie blijft null; nooit afgeleid uit de plaatsnaam. |
| `<dl>` Afdeling/Rol/Locaties/Status werken op afstand | `bronSpecifiek.label_block` | Verbatim onder eigen sleutels. **"Locaties" is bewust geen canoniek `locatie`**: "Circle8 Nederland" is de werkgeversentiteit, minder precies dan addressLocality. |
| description "salaris tussen de €…" | `labelBlock.tarief` → `tarief` | Maandsalaris-band; "salaris" blijft in de capture zodat de parser `maand` kiest (€3656–€4500/maand), nooit een bare-euro-uurtarief. |
| description "werkt tussen de X en Y uur" | `labelBlock.urenPerWeek` → `uren_per_week` | "32 en 40 uur" → "32–40" via de `en|tot`-connector in `hoursTextToPerWeek` (gedeelde normaliser, CTP-541). |
| "Contact"-kaart `/people/<id>-<slug>` + rolspan | `contactpersonen` | naam + rol uit de kaart; telefoon uit de op-naam-geankerde slotzin ("contact op met <naam> <titel> <nummer>"). |
| ontbrekend `validThrough` | sluitingsmoment | UNKNOWN; geen deadline afgeleid. |
| ontbrekende start-/einddatum | `startDatum`/`eind_datum` | UNKNOWN — `datePosted` is een publicatiedatum, geen startdatum. |

## Robots, crawl-delay en known hashes

`robots.txt` (live geverifieerd) disallowed `/app/`, `/messages/`,
`/messenger/`, `/facebook/tab/` en `/jobs/internal/` — geen van die paden
raakt de publieke `/jobs`-listing of -details; de sitemap is er vermeld maar
wordt niet gebruikt. `Crawl-delay` is niet gedeclareerd; de connector gebruikt
de projectcrawl-delay van 2 seconden.

`listingHashCoversDetail: false` — het listing-item bevat alleen de URL; alle
detailvelden (tarief, uren, contact, label_block) zitten op de detailpagina.

## Voorwaarden

- robots.txt: werkenbij.circle8.nl: HTTP 200, geen Disallow op connectorpaden (/, /jobs/), geprobed 2026-09-25
- ToS/gebruiksvoorwaarden: niet gevonden
- Besluit: `te_toetsen`
- Besluitnemer en datum: open voor Robbie (geen besluit vastgelegd)

## Contactpersonen en PII

De "Contact"-kaart publiceert naam + functietitel; de vacancy-slotzin het
directe nummer — gepubliceerd voor sollicitanten (`publicatiedoel:
"sollicitant"`, default-beleid). De recorder redacteert het nummer in
fixtures naar `+31000000000`; de spec asserteert die geredacteerde vorm.
