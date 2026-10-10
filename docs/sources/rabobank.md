# Rabobank — ingest-recept

Status: **probe afgerond; connector toegevoegd** — adapter-categorie `json-ld`.
Rabobank publiceert Nederlandstalige en Engelstalige tweelingen voor dezelfde
vacature. De connector neemt alleen de EN-detailpagina op; de NL-tweeling zou
dezelfde `JR_*`-vacature dubbel laten instromen.

De careers-frontend gebruikt Sanity CMS-project `dwhem0hv`; de connector leest
de publieke sitemap en detailpagina's en gebruikt geen directe Sanity- of
Workday-API.

## Endpoints

| Doel | URL | Opmerking |
|---|---|---|
| Home | `GET https://rabobank.jobs/en/` | Careers-home; geen detaildiscovery. |
| Vacaturelijst | `GET https://rabobank.jobs/en/jobs/` | Ongeveer 121 jobs in de live inventaris; geen discovery-oppervlak voor deze connector. |
| Sitemap | `GET https://rabobank.jobs/api/sitemap/` | Sitemap-urlset; ongeveer 242 vacaturelocaties: circa 121 JR's met EN+NL-tweelingen. |
| EN detail | `https://rabobank.jobs/en/job/<slug>/JR_<nummer>/` | Detailpagina met JobPosting JSON-LD. |
| Sample detail | `https://rabobank.jobs/en/job/active-directory-engineer/JR_00144349/` | Literal sample `JR_00144349`; title bevat bewust dubbele spatie. |

De sitemap wordt als standaard XML-urlset verwerkt. Jina leverde de live feed
als gerenderde markdown met URL's; het fixture-pad blijft de CI-authority en
legt het waargenomen XML-formaat vast. Als de live endpoint in de toekomst
anders dan XML antwoordt, moet dat eerst worden onderzocht.

## Discovery en locale policy

De connector behoudt uitsluitend URL's die exact passen bij
`/en/job/[^/]+/JR_\d+/`. Alle `/nl/vacature/`-URL's worden uitgesloten,
omdat zij EN+NL-tweelingen van dezelfde `JR_*`-requisitie zijn. Ook CMS-roots,
zoek- en vacaturelijsten, job-alerts, `/artikel/`, `/article/`,
`traineeships`, `techblog`, `overview` en niet-JR detailruis vallen buiten de
discovery.

## Voorwaarden

- robots.txt: rabobank.jobs: HTTP 403, geprobed 2026-09-25
- ToS/gebruiksvoorwaarden: niet gevonden
- Besluit: `te_toetsen`
- Besluitnemer en datum: open voor Robbie (geen besluit vastgelegd)

## Veldmapping → canoniek `aanvraag`

| Rabobank JSON-LD | Canoniek | Provenance/noot |
|---|---|---|
| `title` | `titel` | Sample blijft letterlijk `Active Directory  Engineer` (dubbele spatie). |
| `description` | `beschrijving` | De JobPosting-body wordt overgenomen; geen Next jobData-synthese. |
| URL-pad | `bron_referentie` | De EN-detail-URL wordt behouden. |
| `identifier.value` | `bronSpecifiek.identifier.value` | Sample: `JR_00144349`. |
| `datePosted` | `bronSpecifiek.publicatiedatum` | Sample: `2026-09-15`. |
| `employmentType` | `bronSpecifiek.contract_type` | Sample: `fulltime`. |
| `hiringOrganization.name` | `opdrachtgeverNaam` | Sample: `Rabobank`. |
| `jobLocation.address.addressLocality` | `locatieTekst` | Sample: `Utrecht`. |
| `jobLocation.address.addressCountry` | `locatieLand` | Shared normaliser: `NL`; bronwaarde is `nl`. |
| `jobLocation.address.streetAddress` / `postalCode` | `bronSpecifiek`-payload | Gepubliceerd in de JSON-LD-node; niet apart gecureerd. |

Historische Workday Recruiting analyticsvelden en de embedded apply-flow zijn
geen discoverybron. De connector crawlt geen Workday-board en maakt geen
synthetische `jobData`-velden aan. `voorwaardenStatus` blijft
`te_toetsen` vóór activatie.

## Robots, egress en known hashes

De robots-capture is permissief: `User-agent: *` heeft een lege `Disallow` en
verwijst naar `https://rabobank.jobs/api/sitemap/`.

De probe-box en deze VM krijgen bij Rabobank HTTP **403** met de melding
**“Tijdelijk niet beschikbaar”**. Voor live ingest is daarom NL-capable egress
nodig; `RABOBANK_LIVE` blijft uitgeschakeld zolang die route ontbreekt. De
fixtures zijn leidend voor CI.

`listingHashCoversDetail: false`: sitemap-`lastmod` beschrijft alleen de
sitemap-entry en niet de JobPosting-body. Known hashes worden daarom niet naar
de connector doorgestuurd, zodat detail-only wijzigingen niet worden
overgeslagen.
