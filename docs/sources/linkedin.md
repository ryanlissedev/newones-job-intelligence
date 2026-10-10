# LinkedIn Jobs — ingest-recept

Status: **probe afgerond; connector toegevoegd** — adapter-categorie `json-ld`
(detail levert een `JsonLdFetchedPayload`; de gedeelde JSON-LD-normaliser
draait ongemoeid). POC voor CTP-549: de eigenaar heeft de ToS- blokkade voor
deze POC opgeheven; `voorwaardenStatus` blijft `te_toetsen` zodat een latere
beoordeling niet verdwijnt.

## Endpoints

| Doel | URL | Opmerking |
|---|---|---|
| Listing (guest) | `GET https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=freelance&location=Netherlands&start=<n>` | HTML-fragment met ~10 `base-card`-kaarten per pagina. 200 zonder login (live geprobeerd 2026-09-18, ook op `start`=10/50/200). |
| Detail (publiek) | `GET https://nl.linkedin.com/jobs/view/<slug>-<jobId>` | Volledige gastpagina; bevat meestal een JobPosting `ld+json`-node plus topcard- en criteria-markup. |
| Detail (guest api, reserve) | `GET https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/<jobId>` | Geverifieerd 200 zonder login: topcard + criteria + description-fragment, **geen** `ld+json`. Niet gebruikt — de publieke pagina is strikt rijker. |

## Discovery

De discovery-surface is vast: `keywords=freelance&location=Netherlands`
(een deterministische, relevante categorie, zoals Jobbirds freelance/zzp-
pagina). `discover` pagineert met de `start`-offset (`checkpoint.cursor`
bewaart `{seen, start}`); elke kaart levert `data-entity-urn=
"urn:li:jobPosting:<id>"` plus de `base-card__full-link`-href. De href
draagt per-request trackingparams (`position`, `refId`, `trackingId`) — de
connector canonicaliseert naar origin+pathname, anders zouden `bronUrl`,
`bronReferentie` en de listinghash bij elke poll roteren.
`LINKEDIN_MAX_LISTING_PAGES = 5` (~50 jobs/run); een volle pagina op de cap
rapporteert `truncated`.

## Detailpagina-varianten (belangrijk)

De publieke `/jobs/view/`-pagina serveert de JobPosting `ld+json`-node
**niet-deterministisch**: bij de captures van 2026-09-18 (zelfde UA, zelfde
route) hadden 2 van 3 pagina's géén `ld+json`, terwijl topcard, criteria en
description-markup wél identiek aanwezig waren. `parseLinkedinDetail`
gebruikt daarom `extractJobPosting` wanneer de node er is, en
`synthesizeJobPostingFromLinkedinMarkup` anders — zelfde pagina, zelfde
velden voor zover markup ze publiceert. Fail closed: geen titel én geen
description → `jobPosting: null` → item `rejected`. Een 404 op de
detailpagina is "removed at source", geen runfout.

## Veldmapping → canoniek `aanvraag`

| Bron | Canoniek | Provenance/noot |
|---|---|---|
| `jobPosting.title` / `topcard__title` | `titel` | ld+json wint; markup-synthese vult. |
| `jobPosting.description` / `show-more-less-html__markup` | `beschrijving` | ld+json is entity-encoded; markup-synthese levert ruwe inner-HTML. |
| `jobPosting.hiringOrganization.name` / `topcard__org-name-link` | `opdrachtgeverNaam` | `sameAs` uit de company-href (query gestript). |
| `jobLocation.address.addressLocality` / `topcard__flavor--bullet` | `locatieTekst` | `locatieLand` vast "NL" (discovery filtert op Netherlands). |
| Canonieke detail-URL | `bron_referentie` / `bronUrl` | `jobs/view/<slug>-<jobId>`; trackingparams weg. |
| `identifier` | `bronSpecifiek.identifier` | `PropertyValue` met `name:"LinkedIn"`, `value:<jobId>`; bij ld+json de door LinkedIn gepubliceerde node. |
| `jobPosting.datePosted` | `bronSpecifiek.publicatiedatum` | Alleen in ld+json-variant aanwezig; markup heeft enkel "3 weken geleden" (`labelBlock.geplaatst`) → afwezig blijft afwezig. |
| `jobPosting.validThrough` | sluitingsmoment (`sluitingsdatum`) | Alleen ld+json-variant. Let op: LinkedIn's validThrough is een platform-expiry (~datePosted+6mnd), géén klant-deadline — wel de eerlijke bron voor "verdwenen bij de bron". |
| `jobPosting.employmentType` / criteria "Employment type"/"Soort baan" | `bronSpecifiek.contract_type` (+ canoniek `contracttype`) | Synthese mapt mechanisch naar schema.org-tokens (Fulltime→FULL_TIME, Contract→CONTRACTOR, …); ongemapt blijft verbatim. |
| criteria Seniority/Job function/Industries | `labelBlock.seniority_level`/`job_function`/`industries` | Labels gelokaliseerd (EN+NL afgedekt in `LINKEDIN_CRITERIA_LABELS`); `industries` landt ook in `jobPosting.industry` bij synthese. |
| `num-applicants__caption` | `labelBlock.applicants` | "Meer dan 200 sollicitanten" — engagement-tekst, verbatim. |
| `baseSalary` → `tarief` | `tarief` | Niet gepubliceerd in de captures; gedeelde normaliser valt terug op description-mining zoals bij elke json-ld-bron. |
| `startDatum` | `startDatum` | LinkedIn publiceert geen startdatum → UNKNOWN. |
| `contactpersonen` | — | Niet gepubliceerd op deze route. |

## Robots, crawl delay en known hashes

`linkedin.com/robots.txt` disallowt `/jobs-guest/` niet expliciet voor deze
paden op het moment van de opname; de POC-avg is gedocumenteerd onder CTP-549.
Seed `crawlDelayMs: 2000`; één sequentiële request per `start`-pagina,
max 5 pagina's per run.

`listingHashCoversDetail: false`: de listinghash dekt kaartvelden (titel,
opdrachtgever, locatie, geplaatst, canonical url) maar ziet detail-edits
(description, criteria, verdwenen posting) niet — known hashes worden niet
doorgegeven, fetch is altijd live/fixture.

Fixture-captures: listing `2026-09-18T20:05:25.358Z`, detail-4419416701
`2026-09-18T20:06:03.134Z` (zónder ld+json), detail-4468200147
`2026-09-18T20:06:04.988Z` (zónder ld+json), detail-4456662010
`2026-09-18T20:06:06.847Z` (mét JobPosting ld+json).

## Voorwaarden

- robots.txt: www.linkedin.com: HTTP 200; `User-agent: *` heeft `Disallow: /` — connectorpaden / geblokkeerd, geprobed 2026-09-25
- ToS/gebruiksvoorwaarden: niet gevonden
- Besluit: `te_toetsen`
- Besluitnemer en datum: open voor Robbie (geen besluit vastgelegd)
