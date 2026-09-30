# Randstad — ingest-recept

Status: **probe afgerond; connector toegevoegd** — adapter-categorie `json-ld`.
Randstad publiceert JobPosting JSON-LD op vacaturepagina's van de eigen
staffingportal.

## Endpoints

| Doel | URL | Opmerking |
|---|---|---|
| Sitemap | `GET https://www.randstad.nl/job-sitemap.xml` | Ongeveer 3118 vacature-URL's; de eerste vijf staan in de fixture. |
| Detail | `https://www.randstad.nl/vacatures/<numeriek-id>/<slug>` | Detailpagina met JobPosting JSON-LD. |
| Sample detail | `https://www.randstad.nl/vacatures/752363/teamleider` | JSON-LD bevat identifier `752363` en een maandloonband. |

## Discovery en veldmapping

Elke sitemap-entry heeft exact de vorm `/vacatures/<numeriek-id>/<slug>`.
Alleen de kale `/vacatures`-root (ook met querystring) wordt defensief
uitgesloten. De sitemap bevat het hele staffingbord: vast, tijdelijk en
interim zijn gemengd en er is geen deterministisch ICT/interim/freelance-
of detacheringfilter op sitemap- of robotsniveau. Dit past bij de wave-2
probe (`randstad-nl-interim`): er is geen aparte Randstad NL interim/zzp-
brand; de algemene staffingportal dekt dienstverband en interim samen.

| Randstad JSON-LD | Canoniek | Provenance/noot |
|---|---|---|
| `title` | `titel` | Letterlijk overgenomen. |
| `description` | `beschrijving` | HTML wordt door de shared normaliser gestript. |
| URL-pad | `bron_referentie` | Het vacaturepad blijft de referentie. |
| `identifier.value` | `bronSpecifiek.identifier.value` | Vacaturenummer. |
| `datePosted` | `bronSpecifiek.publicatiedatum` | Publicatiedatum, niet startdatum. |
| `employmentType` | `bronSpecifiek.contract_type` | Alleen een string wordt door de shared normaliser gecureerd; arrays blijven absent. |
| `hiringOrganization.name` | `opdrachtgeverNaam` | `Randstad`, de broker; eindklant blijft UNKNOWN (CTP-516). |
| `jobLocation.address.addressLocality` | `locatieTekst` | Eerste gepubliceerde locatie. |
| `baseSalary` | `tarief` | EUR-band met `MONTH` of `HOUR`, als gepubliceerd. |
| `validThrough` | sluitingsmoment | Alleen als de bron dit veld publiceert. |

## Robots, crawl-delay en known hashes

De live robots.txt noemt deze sitemap en blokkeert `/vacatures/` niet. Er is
geen sitemap-specifieke crawl-delay vastgelegd; de connector gebruikt daarom
de projectvloer van 2 seconden. `listingHashCoversDetail: false`: de sitemap
kan de JSON-LD-detailvelden niet afdekken, dus detailwijzigingen mogen niet
door known hashes worden overgeslagen.

De fixture → connector → normalise → curate-assertie staat niet in deze
source-test: curatie gebruikt `createBronRuntimeClient` en vereist live
Postgres; daarvoor zouden `apps/worker/src/curation-recovery.spec.ts` en
infra-scope moeten wijzigen, buiten deze lane.

## Voorwaarden

- robots.txt: www.randstad.nl: HTTP 200, geen Disallow op connectorpaden (/, /vacatures/741140/, /vacatures/749250/, /vacatures/752363/), geprobed 2026-09-25
- ToS/gebruiksvoorwaarden: niet gevonden
- Besluit: `te_toetsen`
- Besluitnemer en datum: open voor Robbie (geen besluit vastgelegd)
