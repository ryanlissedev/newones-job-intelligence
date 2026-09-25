# Bij Oranje — ingest-recept (geverifieerd 2026-09-16)

Status: **probe afgerond; connector toegevoegd** — adapter-categorie `json-ld`.
Bij Oranje is een overheid-interim broker. De sampledetailpagina is een
Laravel/Livewire/InfyOm-pagina; de connector gebruikt de gedeelde JSON-LD-parser.

## Endpoints

| Doel | URL | Opmerking |
|---|---|---|
| Job sitemap | `GET https://www.bijoranje.nl/sitemap-jobs-1.xml` | Voorkeursdiscovery; de live inventaris bevat ongeveer 839 vacature-URL's. |
| Sitemap-index | `GET https://www.bijoranje.nl/sitemap.xml` | Staat als sitemap in `robots.txt`; de job-sitemap is de gerichte feed. |
| Detail | `GET https://www.bijoranje.nl/vacatures/<categorie>/<slug>-<id>` | SSR met een `JobPosting` JSON-LD-node. |
| Sample detail | `https://www.bijoranje.nl/vacatures/onbekend/data-analist-noord-holland-65099` | Referentie-ID `65099`. |

## Veldmapping → canoniek `aanvraag`

| Bij Oranje JSON-LD | Canoniek | Provenance/noot |
|---|---|---|
| `title` | `titel` | Detailpagina; samplewaarde `Data Analist`. |
| `description` | `beschrijving` | Detailpagina. |
| URL-pad | `bron_referentie` | Stabiele referentie uit het detail-URL-pad. |
| `identifier` | `bronSpecifiek.identifier` | Samplewaarde `{ name: "Bij Oranje", value: "65099" }`. |
| `employmentType` | `bronSpecifiek.contract_type` | Samplewaarde `CONTRACTOR`. |
| `datePosted` | `bronSpecifiek.publicatiedatum` | Samplewaarde `2026-09-15`. |
| `validThrough` | sluitingsmoment | Samplewaarde `2026-09-23T00:00:00+00:00`. |
| `hiringOrganization.name` | `opdrachtgeverNaam` | Samplewaarde `OD NHN`; niet verder geïnterpreteerd als broker/eindklant. |
| `jobLocation.address.addressRegion` | `provincie` | Samplewaarde `Noord-Holland`; `addressLocality` ontbreekt in de sample. |
| `jobLocation.address.addressCountry` | `locatieLand` | `NL`. |
| `baseSalary` | **niet overnemen als tarief** | Sample publiceert EUR/HOUR met waarde `0`; dit is een placeholder en geen echt tarief. |

## Ingest-patroon

- Lees `sitemap-jobs-1.xml` en fetch de detail-URL's die op een vacature-ID
  eindigen.
- Respecteer een crawl-delay van 2 seconden.
- De config accepteert de sitemap's `www`-host; een eventuele niet-`www`
  duplicaat-URL wordt uitgesloten.
- Er is geen betrouwbaar labelblok aanwezig in de sample; alle mapping is
  JSON-LD-only.

## Robots en voorwaarden

`https://www.bijoranje.nl/robots.txt` staat crawling toe (`Allow: /`) en verwijst
naar `https://www.bijoranje.nl/sitemap.xml`. De leverancier-
inschrijfvoorwaarden staan op `https://bijoranje.nl/terms-conditionss`.
Er is in de inventaris-skim geen expliciet publiek scrapeverbod gevonden;
`voorwaardenStatus` blijft daarom **`te_toetsen`** vóór activatie.

## Voorwaarden

- robots.txt: www.bijoranje.nl: HTTP 200, geen Disallow op connectorpaden (/, /vacatures/onbekend/), geprobed 2026-09-25
- ToS/gebruiksvoorwaarden: zie "Robots en voorwaarden" hierboven
- Besluit: `te_toetsen`
- Besluitnemer en datum: open voor Robbie (geen besluit vastgelegd)

## Overlap, deduplicatie en known hashes

De inhoud kan overlappen met Opdrachtoverheid en Flextender. Dit is geen
`ALIAS`: normale identity-paden en deduplicatie moeten de overlap afhandelen.

`listingHashCoversDetail: false`: de sitemap-hash ziet alleen de URL (en, als
aanwezig, `lastmod`), terwijl de relevante JobPosting-velden op de detailpagina
staan. Om detail-only wijzigingen niet te bevriezen, wordt de known-hash-store
niet doorgestuurd (RJC-357/RJC-401, dezelfde beslissing als BlueTrail).
