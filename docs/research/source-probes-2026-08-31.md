# Bronprobes — negen Slice C-bronnen

Datum 2026-08-31. Read-only browser-probe van acht bronnen plus de apart uitgevoerde Chrome-probe van Need Staffing. Dit rapport legt alleen de aangeleverde probe-uitkomsten en drie opgeslagen API-samples vast; er is geen aanvullend brononderzoek gedaan.

Besluit Ryan, 2026-08-31: ongedocumenteerde JSON-endpoints MOGEN gebruikt worden, met een expliciete fallback naar SSR/JSON-LD, en elke bron die zo'n endpoint gebruikt moet in zijn doc vermelden dat het een privé, ongedocumenteerd API is dat zonder waarschuwing kan wijzigen.

## Samenvatting

Y = aanwezig, P = gedeeltelijk, N = afwezig en ? = niet vastgesteld in de aangeleverde probe.

| Bron | Adapter | Waarom | Volume | Titel | Opdrachtgever | Locatie | Uren | Tarief | Start | Deadline | robots / ToS | Blocker |
|---|---|---|---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|---|---|
| BlueTrail | `json-ld` | WordPress SSR, `job-sitemap.xml`, JobPosting per detail en labeltabel voor datums | 144 | Y | P | Y | Y | N | Y | Y | Crawl-delay 5; sorteer-/filter-URL's uitgesloten | geen |
| Hero.eu | `json-ld` + HTML-lijst | Next.js RSC SSR; JobPosting alleen op detail; dunne data | 49 | Y | N | Y | Y | N | N | N | `/api/` uitgesloten; AI-bots toegestaan | geen |
| Pro-Act IT | `json-ld` | WordPress SSR, `vacancy-sitemap.xml`, JobPosting en gelabeld detailblok | 17–20 | Y | Y | P | Y | P | Y | Y | Crawl-delay 10 | geen |
| Onefellow | `json-api` | Publieke Supabase-edgefunctie levert alle 50 opdrachten; site is anders een SPA | 50 | Y | Y | Y | Y | P | Y | Y | alles toegestaan; geen ToS-wall gezien | geen |
| Harvey Nash | `json-api` + `json-ld` | Client-side POST-search; SSR-detail met JobPosting als fallback/verrijking | 30 | Y | Y | Y | Y | Y | Y | Y | alles toegestaan | geen |
| Flinter | `html` | SSR-kaarten, geen JSON-LD of API; detail is grotendeels vrije tekst | 18 | Y | Y | Y | P | N | N | N | alles toegestaan | geen |
| Striive | `json-api` | Publieke CMS-API levert 100 records; detail publiek; JSON-LD is malformed | 100 | Y | Y | Y | Y | N | Y | Y | alles toegestaan | Auth0 alleen bij reageren |
| Opdrachtoverheid | `json-api` + `json-ld` | `/search` levert 25 per pagina en bronattributie; SSR-JobPosting als alternatief | ~375 | Y | Y | Y | Y | Y | Y | Y | filter-querystrings uitgesloten | geen |
| Need Staffing | `html` | Server-rendered lijst met paginering en detailpagina's | 63 | Y | ? | ? | ? | Y | ? | ? | geen `robots.txt`; ToS niet vastgesteld | geen Cloudflare-challenge |

## 1. BlueTrail

- Listing: `https://www.bluetrail.nl/opdrachten/`; klassiek server-rendered, 14 detaillinks per pagina en paginering. De header noemt 144 opdrachten; `job-sitemap.xml` bevat 145 locaties: 144 jobs plus de listing.
- Details volgen `/opdrachten/Interim/<slug>/` en bevatten JobPosting JSON-LD plus een zichtbare label/waarde-tabel. De JSON-LD noemt Circle8 als broker; de eindklant staat alleen gedeeltelijk in de beschrijvende tekst.
- Beschikbaar: titel, locatie, uren, start- en einddatum, verlengingsoptie, deadline, referentienummer en opleidingsniveau. Een tarief staat niet op de pagina.
- `baseSalary.value` bevat in de sample `"100"`, maar is onbetrouwbaar en mag niet als tarief worden gebruikt.
- `robots.txt` schrijft `Crawl-delay: 5` voor en sluit sorteer- en filter-URL's uit. Listing, details en de Yoast-achtige sitemapstructuur zijn niet uitgesloten.
- Adapter: sitemap-gedreven `json-ld`; combineer JobPosting met de label/waarde-tabel en respecteer de crawl-delay.

## 2. Hero.eu

- Listing: `https://hero.eu/interim-opdrachten`; Next.js App Router/RSC, server-rendered, zonder JSON-LD op de listing. Alle 49 actuele interim-opdrachten en 49 detaillinks staan op één pagina.
- Details volgen `/interim-opdrachten/<slug>-<8-hex>` en bevatten JobPosting JSON-LD met titel, beschrijving, publicatiedatum, broker, URL, taal, locatie, contracttype en werkuren.
- Beschikbaar: titel, regio/locatie, uren, werkvorm en sector. De opdrachtgever is geanonimiseerd; tarief, start en deadline ontbreken.
- `robots.txt` staat de publieke pagina's toe, sluit onder meer `/api/` uit en staat GPTBot, ChatGPT-User en OAI-SearchBot expliciet toe. De interne API mag daarom niet worden gebruikt.
- Adapter: detail-`json-ld`; ontdek links via de HTML-listing of sitemap.

## 3. Pro-Act IT

- Listing: `https://pro-act.nl/vacatures/`; klassieke WordPress-SSR zonder paginering. De listing bevat 17 detaillinks; `vacancy-sitemap.xml` bevat 20 locaties, inclusief evergreen- en interne rollen.
- Details volgen `/vacatures/<slug>-<id>/` en bevatten JobPosting JSON-LD. `employmentType=FULL_TIME` is niet betrouwbaar voor interim; `jobLocation` bevat in de sample alleen het land.
- Beschikbaar: titel, eindklant in de tekst, hybride locatie, uren, start, einddatum en deadline. Tarief is gedeeltelijk beschikbaar als `marktconform`, zonder numerieke waarde.
- De velden Start, Eind, Inzet, Tarief en Locatie staan als gelabeld blok in de beschrijving.
- `robots.txt` schrijft `Crawl-delay: 10` voor; de Yoast-sitemap verwijst naar `vacancy-sitemap.xml`.
- Adapter: sitemap-gedreven `json-ld`, aangevuld met het gelabelde beschrijvingsblok. Een volledige pass over 20 URL's duurt door de crawl-delay ongeveer 3,5 minuut.

## 4. Onefellow

- `https://onefellow.nl/opdrachten` is een React-SPA. Na hydration toont de pagina 50 opdrachten; de client-side ItemList bevat 20 JobPosting-items en de kaarten routeren naar `/opdrachten/<joborder_id>`.
- `GET https://yhjktxqtoyeruztiwupf.supabase.co/functions/v1/olli-jobs?action=list` gaf zonder API-key of Authorization-header `{jobs:[50]}` terug.
- Records bevatten onder meer opdracht-id, titel, eindklant, locatie, uren, werkvorm, looptijd, start, deadline, publicatietijd, status, teaser en beschrijving. `max_rate` is slechts bij 7 van 50 records gevuld; anders toont de UI `marktconform`.
- Detailpagina's bevatten na hydration JobPosting JSON-LD en tonen ook referentienummer, ZZP-geschiktheid en contractduur.
- `robots.txt` staat de publieke site toe; de sitemap bevat geen job-URL's. Er is geen ToS-wall gezien.
- Adapter: één voorzichtige API-call per poll, maximaal eens per enkele uren. Fallback: browser-rendered `/opdrachten/<id>` met JobPosting JSON-LD.

## 5. Harvey Nash

- Listing: `https://www.harveynash.nl/vacatures`; Next.js Pages, client-rendered, 15 resultaten per pagina. De probe en API noemen 30 live opdrachten.
- De listing gebruikt `POST https://www.harveynash.nl/_sf/api/v1/jobs/search.json` zonder waargenomen auth-header. Paginering gaat via `offset` en `jobs_per_page`.
- Resultaten bevatten onder meer id, titel, HTML-beschrijving, adressen, geodata, categorieën, externe referentie, slug, salarisvelden en publicatie-/vervaldatums.
- Details volgen `/vacatures/<numericId>-<slug>` en zijn SSR met JobPosting JSON-LD. De zichtbare tekst bevat opdrachtgever, locatie, uren, tarief, start, duur en deadline.
- De JSON-LD-`baseSalary` is garbage: GBP, `unitText=YEAR` en een vrije tarieftekst als waarde. Parse daarom de gelabelde tekst, niet de gestructureerde salarisvelden.
- `robots.txt` staat alles toe en noemt de sitemap; er is geen crawl-delay. Cookiebot is cosmetisch en reCAPTCHA beschermt formulieren, niet de zoekactie.
- Adapter: JSON-API op offset, met sitemap → SSR-detail → JobPosting als pure-GET fallback en verifier/enricher.

## 6. Flinter

- Listing: `https://www.flinter.nl/opdrachten`; custom SSR zonder paginering, JSON-LD of XHR. Alle 18 opdrachten staan op één pagina.
- Kaarten bevatten titel, plaats, grove duur en eindklant. Details volgen `/opdrachten/<slug>` en zijn eveneens SSR.
- Beschikbaar: titel, eindklant, locatie en duur. Uren staan soms alleen in vrije tekst; tarief, start en deadline ontbreken.
- De geprobeerde opdracht leek inhoudelijk op een vaste vacature, met salarisrange en dienstverband, ondanks publicatie onder `/opdrachten`.
- `robots.txt` staat alles toe en heeft geen crawl-delay. In het gecontroleerde deel van de statische sitemap waren job-URL's niet bevestigd.
- Adapter: HTML-listing voor de gestructureerde kaartvelden; detail alleen voor aanvullende vrije tekst.

## 7. Striive

- Listing: `https://striive.com/nl/opdrachten`; Angular SSR met hydration. De 27 MB HTML bevat een 25 MB TransferState-blob met afbeeldingen en de eerste 25 van 100 opdrachten.
- `GET https://striive-cms.codebridge.nl/api/jobs?open=true` is publiek, CORS-open en gaf zonder auth-header `{total:100,data:[…]}` terug.
- Records bevatten titel, HTML-inhoud, status, urenrange, start/einde, locatie en GeoJSON, opdrachtgever, broker/bron, datums, verlenging, tariefvelden, deadlines, referenties en eisen.
- De detail-JSON-LD is malformed door ongequote stringwaarden en kan niet worden geparsed. De detailtekst en opdrachtdetails zijn wel publiek.
- Beschikbaar: titel, opdrachtgever, locatie, uren, start, einde, supplier- en clientdeadline en referentie. De geprobeerde tariefvelden waren nul en `hasMaxRate` was false.
- `robots.txt` staat alles toe. De sitemap bevat SEO-landingspagina's, geen individuele opdrachten. Auth0 staat alleen voor reageren, account, alerts en favorieten.
- Adapter: de JSON-API; voorkom herhaald downloaden van de 27 MB listing en log niet in.

## 8. Opdrachtoverheid

- Listing: `https://www.opdrachtoverheid.nl`; Nuxt 3, client-rendered en infinite scroll. De sitemap bevat 375 `/inhuuropdracht/`-URL's; de API levert 25 records per pagina.
- De listing gebruikt `POST https://kbenp-match-api.azurewebsites.net/search` zonder waargenomen auth-header. Het record heeft meer dan 60 velden, waaronder bron, originele URL, uren, tarief, datums, locatie, categorieën en beschrijvingen.
- Details volgen `/inhuuropdracht/<organisatie>/<titel>/<web_key>` en zijn SSR met dubbele JobPosting JSON-LD. Titel, echte eindklant, locatie, uren, tarief, start, einddatum en deadline zijn aanwezig.
- Dit is een aggregator: `tender_source` en `tender_url` verwijzen naar de oorspronkelijke broker. De sample is een Harvey Nash-record; gebruik deze velden voor cross-source deduplicatie.
- `robots.txt` sluit filter-querystrings uit, maar staat detail en sitemap toe. reCAPTCHA staat alleen in de footer/formulierlaag; er werd geen challenge geserveerd.
- Adapter: private JSON-API met offset-paginering; fallback is sitemap → SSR-detail → JobPosting JSON-LD. Houd de requestfrequentie laag.

## 9. Need Staffing

- Listing: `https://www.needstaffing.nl/Opdrachten`; server-rendered, ongeveer 20 opdrachten per pagina en paginering.
- Volume: 63.
- Details volgen `/Opdrachten/{id}`. De geprobeerde detailpagina `/Opdrachten/15520` bevat een tariefband van `€98-102` en een referentie in de titel, `2026-BZB-0457`.
- Er is geen JSON-LD, sitemap of `robots.txt` aangetroffen. Cloudflare was passief en toonde geen challenge.
- Adapter: HTML-listing met paginering, gevolgd door de server-rendered detailpagina's. Er is geen JSON-endpoint in de probe genoemd.
- Andere veldbeschikbaarheid en ToS-status zijn in de aangeleverde Need Staffing-probe niet vastgesteld.

## Opvallende bevindingen

1. Striive levert malformed JobPosting JSON-LD; de publieke CMS-JSON is de bruikbare gestructureerde route. De SSR-listing is bovendien 27 MB door een grote TransferState-blob.
2. Harvey Nash stopt vrije tarieftekst in een semantisch onjuiste `baseSalary` met GBP en `YEAR`; BlueTrail toont eveneens een onbetrouwbare `baseSalary.value`. Salarisvelden zijn dus geen generieke tariefbron.
3. Opdrachtoverheid aggregeert andere brokers en bevat bronattributie. Zonder `tender_source`/`tender_url` in deduplicatie ontstaat onder meer overlap met Harvey Nash.
4. Onefellow, Harvey Nash en Opdrachtoverheid gebruiken private, ongedocumenteerde JSON-endpoints. Volgens het besluit mogen ze worden gebruikt, maar alleen met de vastgelegde browser-/SSR-/JSON-LD-fallback.
5. Hero verbiedt `/api/` in `robots.txt`; gebruik daar uitsluitend publieke HTML/sitemap en detail-JSON-LD.
6. Need Staffing heeft geen JSON-LD of sitemap; HTML-paginering en detailpagina's zijn de enige geprobeerde route.

## Gesaneerde API-shapes

Van ieder sample staat hieronder precies één record. Persoons- en contactvelden zijn verwijderd: bij Onefellow `contact*`, `recruiter*`, `sourcer`, `notes` en het ingesloten `google_jobposting_schema`; bij Harvey Nash `consultant_name`, `consultant_email` en de consultant-categorie. Die velden zijn weggelaten om PII en contactgegevens niet in de repository te kopiëren. `description`, `teaser`, Harvey Nash `summary` en de drie Opdrachtoverheid-beschrijvingsvarianten zijn op maximaal 120 tekens afgekapt en krijgen bij afkapping `…`. Grote niet-connectorgerichte nested bodies zijn niet in de excerpts opgenomen.

### Onefellow — `jobs[0]`

```json
{
  "joborder_id": 920,
  "title": "#920 Constructiemanager Bouwteam & Ontwerpfase – Waterstofnetwerk Zuidwest Nederland",
  "company": "N.V. Nederlandse Gasunie",
  "company_city": "Groningen",
  "address_city": "Groningen",
  "hours": "24-28",
  "max_rate": "",
  "duration": "5 jaar met optie tot verlenging",
  "workplace_type": "remote",
  "start_date": 1790805600,
  "time_deadline": 1788418800,
  "time_published": 1785448800,
  "status": "Open",
  "teaser": "Wil jij een sleutelrol spelen in één van de grootste energie-infrastructuurprojecten van Nederland? Heb jij ruime ervari…",
  "description": "&lt;p&gt;&nbsp;&lt;/p&gt;&lt;p&gt;&nbsp;&lt;/p&gt;&lt;h1&gt;&lt;span&gt;&lt;strong&gt;Constructiemanager Bouwteam &amp;a…",
  "esco_code": "",
  "esco_title": "",
  "deeplink_portal": "https://portal.onefellow.olliworks.app/portal/joborder/show/920"
}
```

De voorbeelden tonen JSON-typen: ids en Unix-tijden zijn numbers; tekstvelden zijn strings.

### Harvey Nash — `results[0]`

```json
{
  "job": {
    "id": "33623a82-6699-4a07-aee0-cbca9cc5176b",
    "title": "Senior M365 Copilot Adoptie Consultant SF16077",
    "description": "<p><strong>Voor onze eindklant Enexis is Harvey Nash op zoek naar een Senior M365 Copilot Adoptie Consultant.</strong><b…",
    "addresses": ["Zwolle , Overijssel"],
    "external_reference": "BBBH122737_1788167820",
    "url_slug": "298854-Senior-M365-Copilot-Adoptie-Consultant-SF16077",
    "salary_package": "Bespreekbaar",
    "salary_low": 0.0,
    "salary_high": 0.0,
    "published_at": 1788167821,
    "expires_at": 1788825599,
    "updated_at": 1788167821,
    "featured": false
  },
  "commute_info": {},
  "summary": "Ondersteun de Copilot-uitrol per team: je helpt bij intakes, usecaseselectie, voorbereiding van sessies en het uitvoere…",
  "text_snippet": "",
  "title_snippet": ""
}
```

Dit record toont strings, numbers, een boolean, array en object zoals ze in het sample voorkomen.

### Opdrachtoverheid — `negometrix_tenders[0]`

```json
{
  "tender_id": "harveynash_298847",
  "tender_name": "Senior Project- en Programmacoordinator Grootzakelijk",
  "tender_buying_organization": "Enexis",
  "tender_source": "harveynash",
  "tender_url": "https://www.harveynash.nl/vacatures/298847-Senior-Project--en-Programmacoordinator-Grootzakelijk",
  "opdracht_overheid_url": "https://www.opdrachtoverheid.nl/inhuuropdracht/Enexis/Senior-Project-en-Programmacoordinator-Grootzakelijk/36A6A824-B5F2-4D3E-A749-425BA6B99EDD",
  "web_key": "36A6A824-B5F2-4D3E-A749-425BA6B99EDD",
  "tender_first_seen": "2026-08-29",
  "tender_last_seen": "2026-08-31",
  "tender_start_date": "2026-08-29",
  "tender_end_date": "2027-03-15",
  "tender_offline_date": "2026-09-01 16:00:00",
  "tender_min_hours": 32.0,
  "tender_max_hours": 40.0,
  "tender_maximum_tariff": 119.0,
  "tender_no_max_tariff": false,
  "contract_type": "detachering",
  "tender_categories": [
    {"id": 60552, "tender_category_obj": {"id": 11, "type": "Beleid"}},
    {"id": 70940, "tender_category_obj": {"id": 16, "type": "Informatiemanagement"}},
    {"id": 72929, "tender_category_obj": {"id": 20, "type": "Project- en Programmamanagement"}}
  ],
  "tender_job_location": "Nederland",
  "remote_work_description": "De werkzaamheden zijn 50% thuis en 50% op locatie in Arnhem/Den Bosch, met incidentele uitstapjes naar andere Enexis locaties.",
  "extension_option_description": "Een opdracht voor initieel vijf maanden, met mogelijkheid tot verlenging.",
  "tender_description": "Voor onze eindklant Enexis is Harvey Nash op zoek naar een Senior Project- en Programmacoordinator Grootzakelijk. Let op…",
  "tender_description_html": "<div class=\"post-content mt-4 p-4\"><div><p><strong>Voor onze eindklant Enexis is Harvey Nash op zoek naar een Senior Pro…",
  "tender_description_tk": "<h2>Omschrijving</h2>\n<h3>Opdracht omschrijving</h3><p>Wil jij bijdragen aan oplossingen voor netcongestie en de energie…",
  "education_level": 30,
  "experience_level": 30,
  "exclusive": false,
  "oim_vacancy": false,
  "direct_recruitment_vacancy": false
}
```

Ook hier maken de voorbeelden string-, number-, boolean-, array- en objectvelden zichtbaar.
