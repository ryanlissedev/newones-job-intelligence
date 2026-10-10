# Wave 2 · Lane E — MSP/VMS-inventaris (CTP-536 … CTP-571)

Onderzoek 2026-09-17 UTC, read-only met `curl -L` (browser-UA), geen logins, geen omzeiling, max. ~15 requests per site. Ruwe probe-logs (statuscodes, headers, robots, sitemaps, quotes) staan per bron in het onderzoeksarchief van deze lane; de bewijsregels hieronder zijn daaruit overgenomen. Dit is een inventaris, geen connectorbouw: geen bronIds toegekend, geen code.

**Verdict-legenda:** LIVE · ALIAS(of …) · PUBLIC→build-candidate (route: JSON-LD | SSR | sitemap) · LOGIN-ONLY · BLOCKED-ToS · NO-PUBLIC-SURFACE · GATE-0 = juridisch/commercieel besluit nodig vóór enige bouw.

## Verdict-tabel

| Issue | Bron | Verdict | Route | Effort | Aanbeveling |
|---|---|---|---|---|---|
| CTP-536 | Magnit (Wand VMS, ex-Brainnet/PRO Unlimited) | **NO-PUBLIC-SURFACE** → GATE-0 | — (Supplier API / portaal alleen voor gecontracteerde leveranciers) | n.v.t. zonder onboarding | Niet bouwen. Magnit-vraag komt indirect binnen via brokers (BlueTrail `hiringOrganization: Magnit`). Sluiten als "not-missing / not buildable"; heropenen alleen na leveranciersonboarding. |
| CTP-538 | TAPFIN / ManpowerGroup | **NO-PUBLIC-SURFACE** → GATE-0 | — | n.v.t. | Niet bouwen; ToU beperkt kopiëren tot persoonlijk, niet-commercieel gebruik. Sluiten. |
| CTP-542 | Pontoon (Adecco Group) | **NO-PUBLIC-SURFACE** | — (Pontoon draait als MSP op Nétive VMS, zie CTP-547) | n.v.t. | Niet bouwen. Sluiten; tenant-portalen vallen onder de Nétive-lijn. |
| CTP-543 | ProUnity (HeadFirst Group, BE) | **PUBLIC→build-candidate** (sitemap + SSR; géén JobPosting JSON-LD) **maar BE-markt + ToS-IP/databankclausule** → GATE-0 | sitemap `pji_job-sitemap*.xml` → SSR-detail | S (~1 sessie) áls GO | Niet in Wave 3: steekproef 45 missies = 100 % België. Alleen bouwen bij expliciete BE-scope én ToS-GO (HeadFirst-relatie via Striive/Inhuurdesk benutten). |
| CTP-544 | AgileOne | **NO-PUBLIC-SURFACE** / LOGIN-ONLY | — | n.v.t. | Geen NL-aanwezigheid (`agileone.nl` NXDOMAIN). Sluiten. |
| CTP-545 | CXC Global | **NO-PUBLIC-SURFACE** / LOGIN-ONLY (MyCXC) | — | n.v.t. | `cxcglobal.nl` NXDOMAIN. Sluiten. |
| CTP-546 | Het Flexhuis (Nash Squared) | **NO-PUBLIC-SURFACE** | — | n.v.t. | MSP-arm van Nash Squared; hypothese: vraag verschijnt op harveynash.nl (bron-recept bestaat). Sluiten; overlap verifiëren zodra Harvey Nash live is. |
| CTP-547 | Nétive VMS | **NO-PUBLIC-SURFACE** als platform; tenants apart beoordelen | per tenant | n.v.t. | Platform, geen bron. Klanten volgens eigen cases: NS, BAM (Flexplein), Pontoon, Maandag, Pretium, Giant. Geen publieke tenant-listing gevonden. Sluiten als platform-notitie; DioR erin gevouwen. |
| CTP-571 | DioR (Digitale Inhuuroplossing Rijk) | **LOGIN-ONLY** (Salesforce Experience Cloud; 2026-09-17 "down for maintenance") | Playwright-login na leveranciersregistratie | M | Vouwen onder CTP-547 als alias-notitie; SOURCE_MATRIX rung-3 rij blijft staan (lage prio, Rijksinhuur komt via TenderNed-DAS). |
| CTP-548 | Brainnet | **ALIAS(of Magnit)** — bevestigd | — | 0 | Sluiten als niet-aparte bron. |
| — | **Haert** (Driessen Groep; bijvangst) | **PUBLIC→build-candidate** | JSON-LD (JobPosting incl. tarief/uur) + SSR-listing | S (~1 sessie, JSON-LD-adapter) | Voordragen voor Wave 3 (nieuw issue). Eerst `algemene-voorwaarden` lezen. |

## Bewijs per bron

### CTP-536 Magnit

- Registry/SOURCE_MATRIX: rij "Magnit (= Brainnet)" bestaat al onder *Invitation-only of geblokkeerd*; geen `SourceDefinition`, geen `docs/sources/*.md`.
- `https://magnitglobal.com/` → 200; `https://magnitglobal.com/nl` → 200 (titel "Magnit | Het toonaangevend Integrated Workforce Management Platform"); `/opdrachten` → 404.
- `robots.txt` → 200: `User-agent: *` / `Allow: /` / `Disallow: /content/*`. `sitemap.xml` → 404 (AEM `SitemapServlet`).
- Geen publieke opdrachtenlijst in de HTML; alleen loginlinks: "Magnit Portal", "Wand VMS (EU)", "Wand VMS (US)", "Workforce Logiq VMS", "ENGAGE Client", "RatePoint Client".
- Privacyverklaring `/content/prounlimited/nl/nl/privacy-notice.html` → 200: geen scraping/kopieer/databankclausule. Terms-URL's (`/terms-of-use`, `/us/en/terms-of-use.html`, `/content/prounlimited/nl/nl/terms-of-use.html`) → 404; voorwaarden dus niet gevonden, niet "afwezig".
- Indirecte dekking: `docs/sources/bluetrail.md` — BlueTrail-JSON-LD toont `hiringOrganization` Magnit (5 opdrachten).
- Hosting: Cloudflare + Webflow (`x-rp-target-iswebflow: true`), geen challenge.
- **GATE-0:** toegang bestaat uitsluitend als gecontracteerde leverancier (Supplier API / Wand-login) — commercieel besluit, niet technisch.

### CTP-538 TAPFIN / ManpowerGroup

- Niet in registry/SOURCE_MATRIX.
- `https://www.tapfin.com/` → 200 (HubSpot, Cloudflare passief `__cf_bm`); `https://tapfin.nl` → 403; `/marketplace`, `/talent-solutions` → 404.
- Sitemap: 34 URL's, geen job/opdracht/mission-URL's. Geen listing, geen JSON-LD-probe mogelijk.
- ToU `https://www.manpowergroupusa.com/terms-of-use` → 200, quote: *"The copying, downloading and/or printing of information and/or material included on the Site, other than as otherwise expressly permitted by ManpowerGroup, is for User's personal and noncommercial use only …"*. Geen expliciete scraping/robots/databankclausule.
- Merken genoemd: Manpower, Experis, Talent Solutions; geen NL-klantmarktplaats.
- **GATE-0:** alleen via partner-/leveranciersrelatie.

### CTP-542 Pontoon (Adecco)

- Niet in registry/SOURCE_MATRIX.
- `https://www.pontoonsolutions.com/` → 200 (Next.js SSR); `/jobs` → 404. `pontoon.nl` → `https://pontoon.nl/en-gb` = Nameshift domein-te-koop-pagina.
- `robots.txt`: `Disallow: /data/`, `/infos/`; sitemap → 1 statische child-sitemap, geen job-URL's.
- `/terms-of-use` en `/privacy-policy` → 200 maar client-rendered shell zonder clausuletekst (niet beoordeelbaar via curl).
- Adecco-check: `https://www.adecco.nl/nl-nl/vacatures` → 301 → `https://www.adecco.com/nl-nl` (homepage, geen lijst); `jobs.nl.adecco.com/openjob/...` → 200 zonder JobPosting JSON-LD. Adecco-uitzendvacatures vallen buiten de MSP-scope.
- Nétive-koppeling: `https://netivevms.com/cases/pontoon-solutions/` → 200, *"hear directly from Faris Bećirović, Managing Director of Pontoon Germany … one of our valued partners, Pontoon"*.

### CTP-543 ProUnity

- Niet in registry/SOURCE_MATRIX.
- `prounity.nl` en `prounity.com` → 301 → `https://www.pro-unity.com/` (WordPress/Avada, Weglot). Footer: "HeadFirst Group".
- `robots.txt`: WooCommerce-disallows + **`Crawl-delay: 10`**; `Sitemap: /sitemap.xml`.
- Root-sitemap → 10 child-sitemaps incl. `pji_job-sitemap.xml` … `pji_job-sitemap5.xml`; eerste child = **1.000** `<loc>`-entries van de vorm `/job/<uuid>/` (geen `<lastmod>`; historie inbegrepen, niet alleen open missies).
- Publieke listing `https://www.pro-unity.com/freelance-missions/` → 200, 45 job-links server-rendered. Locatiewoorden in de lijst: Brussel 25×, Antwerp 4×, belgium 2×, **Nederland/Netherlands 0×**.
- Detail `https://www.pro-unity.com/job/2d7d21bd-840e-46e9-b43c-1e00dee5140e/` → 200, SSR: titel "Frontend Web Developer (K10127)", duur "2 months", periode "12/10/2026 - 31/12/2026", land "Belgium", rollen/talen/skills, beschrijving (Police Fédérale). **Geen tarief**, "Sign in to apply" → `platform.pro-unity.com`.
- JSON-LD aanwezig maar alleen `BreadcrumbList`, `Organization`, `ImageObject`, `WebPage`, `WebSite` — **geen JobPosting** → route zou SSR-labelparser zijn.
- ToS `https://www.pro-unity.com/terms-of-use/` → 200, quote: *"the User shall not itself or allow a third party to copy, analyze, decompile, make public, distribute, transfer to third parties, or change any content encumbered with Intellectual Property Rights unless expressly permitted by ProUnity."* Definitie IP-rechten omvat *"rights relating to databases"*. Geen expliciete scraping/robotsclausule; privacy-policy zonder relevante clausule.
- **GATE-0:** (a) markt is België, buiten huidige NL-scope; (b) kopieer-/databankclausule vereist toestemming — via HeadFirst Group (zelfde groep als Striive/Inhuurdesk, beide LIVE) commercieel te regelen.

### CTP-544 AgileOne

- Niet in registry/SOURCE_MATRIX.
- `https://www.agile-one.com/` → 200 (Umbraco); `agileone.nl` → DNS-fout; `/jobs`, `/opdrachten` → 404; `/careers/` → 200 (eigen vacatures, geen opdrachten).
- `robots.txt`: `Disallow: /bin`, `/umbraco`, `/umbraco_client`. Sitemap 68 URL's, geen job/opdracht-URL.
- Loginportalen in HTML: `my.allsourcepps.com`, `drivesrm.agile1.com`, `srm.agile1.eu` ("Supplier Login (EU)").
- Privacy-policy → 200, geen scraping/kopieer/databankclausule; geen Terms-pagina gevonden.

### CTP-545 CXC Global

- Niet in registry/SOURCE_MATRIX.
- `https://www.cxcglobal.com/` → 200 (Vercel, geen challenge); `cxcglobal.nl` → DNS-fout; `/jobs`, `/opdrachten` → 404.
- `robots.txt`: `Allow: /` + `Sitemap: /sitemap_index.xml` (9 content-sitemaps, geen job-URL's).
- Portaal "MyCXC" en dienst "Marketplace" genoemd, geen publieke kaarten.
- Terms = PDF `https://cms.cxcglobal.com/wp-content/uploads/2023/05/Terms-and-Disclaimer-CXC.pdf` → 200 (niet uitgelezen); privacy-policy → geen relevante clausule.

### CTP-546 Het Flexhuis

- Niet in registry/SOURCE_MATRIX.
- `hetflexhuis.nl` → 301 → 301 → `https://www.flexhuisglobal.com/nl/` → 200 (WordPress, Varnish); titel "Flexhuis - Flexhuis NL"; footer "Powered by Nash Squared". `flexhuis.nl` is een onverwant modulaire-woningbouwbedrijf.
- `/robots.txt`, `/sitemap.xml`, `/opdrachten`, `/vacatures` op hetflexhuis.nl redirecten alle naar dezelfde homepage → geen robots, geen sitemap, geen listing.
- Diensten: "Managed service provider (MSP)", "RPO", "Total talent solutions"; klantlogo's niet als tekst leesbaar.
- Privacy = `https://www.nashsquared.com/privacypolicy` → 200; geen scraping/kopieer/databankclausule. Geen eigen voorwaarden gevonden.
- Hypothese (ongeverifieerd): Flexhuis-inhuur wordt gepubliceerd via harveynash.nl (`docs/sources/harveynash.md`, 30 live opdrachten bij probe 2026-08-31). Controleren op `hiringOrganization`/tekst "Flexhuis" zodra die connector draait.

### CTP-547 Nétive (+ CTP-571 DioR)

- SOURCE_MATRIX: DioR-rij bestaat (rung 3); Nétive zelf niet. `docs/sources/*` noemt Nétive nergens.
- `netive.nl` → 301 → `https://netivevms.com/` → 200 (HubSpot). `robots.txt` alleen HubSpot-preview-disallows. Sitemap 286 URL's, geen opdrachten. `/opdrachten`, `/inhuur` → 404.
- Klantcases in sitemap: `nl/cases/bam-hiring-desk` ("BAM Flexplein … centrale inleendesk"), `de/customer-stories/dutch-railways` ("NS … arbeitet seit 2010 mit Nétive VMS"), `cases/pontoon-solutions/`, `nl/cases/maandag-managed-services`, `cases/pretium-resourcing`, `cases/giant-group`, `cases/bnp-paribas-fortis/`. NS en BAM zijn al LIVE bronnen — maar via hun **careers-sites** (`werkenbijns.nl`, `bamcareers.com`), niet via het Nétive-inhuurportaal; de VMS-laag (inhuur/DAS) daarvan is niet publiek waargenomen.
- Privacy-policy → 200, geen relevante clausule. Geen publieke Nétive-tenant-listing gevonden; het platform heeft geen eigen bron-oppervlak.
- **DioR:** `https://digitale-inhuuroplossing-rijk.my.site.com/` → 301 `/vms/` → 200 met body *"We are down for maintenance. Sorry for the inconvenience."* en redirect-code naar `/vms/s/login`; headers `x-sfdc-request-id`, `x-sfdc-edge-cache` = Salesforce Experience Cloud. Dat DioR door Nétive is gebouwd (Nétive VMS is een Salesforce-native VMS) is een breed gerapporteerde maar in deze probe **niet bewezen** claim — de Nétive-site noemt DioR/Rijk niet in de sitemap. Het maakt voor het verdict niet uit: beide zijn LOGIN-ONLY.
- Besluit: CTP-571 vouwen in CTP-547 als alias-notitie; geen aparte bron-rij, tenzij product een programma-rij voor DioR wil.

### CTP-548 Brainnet

- Exacte redirectketen: `https://brainnet.nl/` → **301** `https://www.brainnet.nl/` → **301** `https://magnitglobal.com/nl` → **200** (titel "Magnit | Het toonaangevend …"). `/opdrachten` volgt dezelfde keten.
- `www.brainnet.nl/robots.txt` → 200 (leeg `User-agent: *`, twee sitemap-verwijzingen); `sitemap.xml` → 685 corporate URL's, geen opdrachten; `sitemap_en.xml` → redirect naar Magnit.
- **ALIAS(of Magnit) bevestigd**; SOURCE_MATRIX zei dit al. Sluiten.

### Bijvangst: Haert (Driessen Groep)

- `https://www.haert.nl/opdrachten` → 200, Drupal 10 SSR, 3 open opdrachten op probe-datum (Zwemonderwijzer; Medewerker onderwijslogistiek & planning; Projectleider IT Klantcontact). Broker/MSP voor overheid en onderwijs, "Aangesloten bij Driessen Groep".
- Detail `…/opdrachten/projectleider-it-klantcontact-36754` → 200 met **JobPosting JSON-LD**: `employmentType: CONTRACTOR`, `datePosted`, `validThrough`, `identifier`, `baseSalary 125 EUR/HOUR`, `jobLocation 's-Hertogenbosch`, beschrijving noemt eindklant Brabant Water.
- `robots.txt` = Drupal-default (geen disallow op `/opdrachten`). Disclaimer `/content/disclaimer`: geen scraping/kopieerclausule; `/content/algemene-voorwaarden` nog niet gelezen.
- Verwantschap met Nétive is **niet** aangetoond (kwam naar boven als plausibele overheids-MSP-portaal, niet via de Nétive-site).

## Voorgestelde Wave 3-bouwlijst

1. **Haert** — nieuw issue; route JSON-LD (bestaande `json-ld`-adapterfamilie); effort S. Voorwaarde: `algemene-voorwaarden` lezen en vastleggen in `voorwaarden_status`. Laag volume (3 open), maar tarief/uur en eindklant publiek.
2. **Geen** van de negen MSP/VMS-issues levert een bouwbare NL-bron op. Alle MSP-vraag die Catapulze wél kan zien, loopt al via brokers/marktplaatsen (BlueTrail, Striive, Inhuurdesk, Harvey Nash, TenderNed-DAS).
3. **GATE-0-besluiten voor Robbie** (niet bouwen tot besluit): Magnit-leveranciersonboarding (Supplier API/Wand); ProUnity alleen bij BE-scope + toestemming via HeadFirst Group; TAPFIN alleen via partnerrelatie.
4. **Sluiten:** CTP-538, CTP-542, CTP-544, CTP-545, CTP-546, CTP-548; CTP-571 → alias-notitie op CTP-547; CTP-536 en CTP-543 sluiten als "GATE-0 / not buildable now" of parkeren op een commercieel besluit.

## Bekende gaten

- Terms-pagina's van Magnit (404) en Pontoon (client-rendered shell) en de CXC-PDF zijn niet inhoudelijk beoordeeld.
- Flexhuis→Harvey Nash-overlap en Nétive→DioR-bouwer zijn hypothesen, gemarkeerd als zodanig.
- ProUnity: alleen `pji_job-sitemap.xml` (1 van 6) opgehaald; aandeel open vs. historische missies onbekend.
- Er is geen headless-browserprobe gedaan; sites die pas client-side een lijst tonen (Pontoon-terms) kunnen meer bevatten dan hier vastgesteld.
