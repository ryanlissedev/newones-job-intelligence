# Alliander — ingest-recept

Status: **connector toegevoegd** — adapter-categorie `json-ld` met
`detailSynthesizer` + `detailUrlRewrite` (CTP-556, gecorrigeerd 2026-09-30).

## Endpoints

| Doel | URL | Opmerking |
|---|---|---|
| Sitemap | `GET https://werkenbij.alliander.com/sitemap.xml` | 511 URL's waarvan 187 vacature-details `/vacatures/<slug>/jr<id>` (opname 2026-09-30); overige pagina's (vakgebieden, inhuur-overzicht) worden uitgesloten. Let op: `www.werkenbij.alliander.com` heeft een certificaatmismatch — canonieke host is zonder `www`. |
| Detail (fetch) | `GET https://werkenbij.alliander.com/api/vacancy/<JR-id>` | De publieke detailpagina is een client-renderde Next.js/Sitecore-shell; hetzelfde record wordt server-side geserveerd als JSON. `detailUrlRewrite` mapt de publieke URL op dit endpoint; de observatie behoudt de publieke URL. |
| Detail (publiek) | `https://werkenbij.alliander.com/vacatures/<slug>/jr<id>` | Bevat `__NEXT_DATA__`, maar het vacature-object zit niet daarin — de pagina haalt het client-side op bij de API. |

## Correctie op het eerdere verdict

De eerdere inventaris (CTP-556) verbaalde NO-JSONLD en keek alleen naar de
detailpagina-markup. De publieke vacature-API (`/api/vacancies`, `totalAmount:
187`, en `/api/vacancy/<JR>`) bleek onbeschermd bereikbaar en bevat álle velden
getypeerd. Verdict gecorrigeerd naar buildbaar via JSON-synthesis — geen
HTML-scraping nodig.

## Veldmapping en datakwaliteit

| API-record | Canoniek | Provenance/noot |
|---|---|---|
| `jobTitle` | `title` → titel | Letterlijk. |
| `description` | beschrijving | HTML, letterlijk. |
| `employer` | `hiringOrganization.name` → opdrachtgeverNaam | Niet hardcoded: `Liander` komt ook voor (JR18244). |
| `location`, `primaryPostalCode` | `jobLocation.address` → locatieTekst | `addressCountry` `NL`. |
| `id` | `identifier` + `labelBlock.referentienummer` | `JR`-referentie. |
| `publicationDate`, `endDate` | `datePosted` → publicatiedatum, `validThrough` → sluitingsdatum | ISO-datums, letterlijk. |
| `scheduledWeeklyHours` | `workHours` + `labelBlock.urenPerWeek` → uren_per_week | Numeriek veld (40), wordt "40 uur". |
| `contractType` | `employmentType` → contract_type | Verbatim (`Fulltime`); geen mapping naar schema.org-enum omdat de vocabulaire ongedocumenteerd is. |
| `field`, `subField`, `educationLevel`, `compensationGrade` | `labelBlock.vakgebied` / `subvakgebied` / `opleiding` / `salarisschaal` | `compensationGrade` is een schaallabel ("Salarisschaal 11"), géén bedrag → nooit `tarief`. |
| `contactPerson`, `contactPersonEmailAddress` | `contactpersonen` (naam + email) | CTP-610: werkenbij-contacten zijn in scope. |
| `template` | — niet overgenomen | DEC-008-minimalisatie. |

De sitemap bevat uitsluitend URL-metadata. Daarom is `listingHashCoversDetail:
false` en worden known hashes niet doorgestuurd. `crawlDelayMs` is 2000 en
`voorwaardenStatus` blijft `te_toetsen`: robots staat alles toe behalve
`/error-pages` en adverteert de sitemap expliciet. De drie vastgelegde details
zijn echte API-opnames; recruitercontact in de description-prosa is mechanisch
geredacteerd; de recruiter-naam in de description-prosa is vervangen door een
generieke placeholder.

## Voorwaarden

- robots.txt: werkenbij.alliander.com: HTTP 200, geen Disallow op connectorpaden (/, /api/vacancy/, /vacatures/business-partner-veiligheid-milieu-en-kwaliteit/, /vacatures/cloud-security-specialist/, /vacatures/gasmonteur-in-opleiding/), geprobed 2026-09-25
- ToS/gebruiksvoorwaarden: niet gevonden
- Besluit: `te_toetsen`
- Besluitnemer en datum: open voor Robbie (geen besluit vastgelegd)
