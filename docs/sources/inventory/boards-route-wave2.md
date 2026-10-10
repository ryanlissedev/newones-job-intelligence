# Wave 2 · Lane G — boards met een route-vraag

Onderzoeksdatum: 2026-09-17. Issues: CTP-587 (Werk.nl / UWV), CTP-594 (Malt.nl).
Alleen onderzoek; geen connector, geen bronId.

Verdict-schaal: LIVE / ALIAS / API→build-candidate / PUBLIC→build-candidate (route) / LOGIN-ONLY / BLOCKED-ToS / GATE-0 (partnerovereenkomst nodig).

| Bron | Verdict | Route | Effort | Aanbeveling |
|---|---|---|---|---|
| Werk.nl / UWV vacaturebank | **BLOCKED-ToS → GATE-0** | geen zonder schriftelijke toestemming UWV | 0 nu; ~1 sessie ná toestemming (SPA-API reverse-engineeren of aangeleverde feed) | Niet bouwen. Issue → GATE-0, eigenaar stuurt aanvraag naar UWV (art. 9/13 AV) of via Gegevensdiensten |
| Malt.nl | **LOGIN-ONLY + BLOCKED-ToS** | geen (freelancer-opdrachten alleen na login; scraping expliciet verboden) | 0 | Drop. Alleen heropenen bij partnerovereenkomst met Malt |

## 1. Werk.nl / UWV (CTP-587)

### Registry / matrix

Geen bestaande bron of alias. Werk.nl ≠ Nationale Vacaturebank (NVB is DPG Media; werk.nl is UWV). `docs/SOURCE_MATRIX.md` had alleen de generieke categorie "Werkenbij-sites".

### Route-probes

| Probe | Resultaat |
|---|---|
| `https://www.werk.nl/robots.txt` | 200. `User-agent: *` / `Disallow: /webpublicaties` / `Sitemap: https://www.werk.nl/nl/sitemap.xml` |
| `https://www.werk.nl/nl/sitemap.xml` | 200, 156 URLs — alleen redactionele pagina's (`/nl/vacatures`, `/nl/werk-zoeken`, `/nl/over-werk-nl/algemene-voorwaarden` …). **Geen vacature-detail-URLs.** `/sitemap.xml` (root) = 404 |
| `/nl/vacatures`, `/nl/werk-zoeken` | 200, maar alleen shell: "Uw sessie verloopt over: … U heeft JavaScript nodig om deze site te kunnen bekijken". Zoeken = Angular-bundle `/werkzoekenden/mijn-werkmap/kia/publiek/apps/zoekenvacatures/main.js` |
| `/werkzoekenden/vacatures/`, `/werkzoekenden/vacatures-zoeken/` | 302 → `login.werk.nl` (Oracle Access Manager, anonieme OAM-sessie). Geen server-side HTML |
| JobPosting JSON-LD op werk.nl | **niet gevonden** (SPA, geen SSR) |
| Rate limits | niet getest — verboden door art. 13, dus niet relevant |
| UWV Open Data · `data.overheid.nl` CKAN `package_search?q=uwv+vacatures` | 7 datasets. Relevant: **UWV Open Match Data**, CC-BY 4.0: "De gegevens onder de open match data zijn vacatures en geanonimiseerde CVs in werk.nl. Voor deze set worden deze **geaggregeerd 1) per beroep en 2) per viercijferig postcodegebied**." → tellingen, geen vacature-records |
| UWV Dashboard Online Vacatures (`uwv.nl/nl/arbeidsmarktinformatie/dashboards/dashboard-online-vacatures`) | maandelijkse statistiek ("3e donderdag van iedere maand geactualiseerd"), POST-API zonder gedocumenteerd contract. Geen listing-feed |
| UWV Gegevensdiensten (`uwv.nl/nl/gegevensdiensten`) | "We delen niet zomaar gegevens over werk en inkomen. U kunt gegevens bij ons afnemen als u voldoet aan deze voorwaarden": wettelijke taak, noodzakelijk, geen alternatief. Geen developer-portal / self-service API voor vacatures |
| `uwv.nl` sitemap | 5.408 URLs, 128 met `/vacatures/` = **werken-bij-UWV** (eigen banen, wél JobPosting JSON-LD, bv. `/nl/werken-bij/vacatures/.../a1WSc0000075sGfMAI`). Dat is een werkgeverssite, niet de vacaturebank |

### Voorwaarden (`https://www.werk.nl/nl/over-werk-nl/algemene-voorwaarden`)

- Art. 9 (gebruik gegevens): "Het is niet toegestaan om (delen van) teksten en hyperlinks van werk.nl te bewerken, te kopiëren en/of op enige wijze aan derden ter beschikking te stellen, tenzij Gebruiker hiervoor schriftelijk toestemming van UWV heeft gekregen." en "Gebruiker zal de cv- en vacaturebank van werk.nl en de daarin ter beschikking gestelde (persoons)gegevens slechts gebruiken voor het plaatsen van vacatures of het in contact komen met Gebruiker."
- Art. 13 (geautomatiseerd gebruik): "Het is de Gebruiker niet toegestaan om gebruik te maken van geautomatiseerde middelen, waaronder maar niet beperkt tot scrapers, bots, spiders of vergelijkbare technologieën, om toegang te verkrijgen tot werk.nl, gegevens (zoals vacatures, cv's en/of gegevens van andere Gebruikers) te verzamelen, te kopiëren of anderszins te onttrekken".
- "Gebruiker zal zich onthouden van het gebruik van enig middel om op werk.nl te navigeren, of te zoeken anders dan de hulpmiddelen die beschikbaar zijn op de website, anders dan de normaal beschikbare browsers van derden, of anders dan de door UWV goedgekeurde tools."
- "Het is niet toegestaan om persoonlijke gegevens in te zien of op te halen vanaf een IP-adres van buiten de EER".

### Verdict Werk.nl

**BLOCKED-ToS** voor elke scraping-/SPA-API-route (art. 13 expliciet; art. 9 verbiedt hergebruik). Geen open API met records: Open Match Data is geaggregeerd. Er is een ontsnappingsroute in de tekst zelf — "door UWV goedgekeurde tools" en "schriftelijke toestemming van UWV" — dus de issue wordt **GATE-0**: pas bouwen na schriftelijke toestemming of een Gegevensdiensten-afspraak. Zonder die toestemming: drop.

Effort: 0 nu. Ná toestemming ~1 sessie (UWV levert waarschijnlijk een feed of goedgekeurd endpoint; anders reverse-engineeren van de `zoekenvacatures`-Angular-API onder OAM-sessie).

## 2. Malt.nl (CTP-594)

### Registry / matrix

Geen bestaande bron of alias (freelancer.nl is een andere marktplaats).

### Publiek vs. login — freelancer-zijde vs. opdrachtgever-zijde

- **Publiek** (via Chrome, zonder login): homepage, `/s` freelancer-zoekresultaten en `/s/tags/*` — dat zijn **freelancer-profielen**, bedoeld voor opdrachtgevers. Voor ons irrelevant (geen opdrachten).
- **Login-only**: opdrachten voor freelancers. `https://www.malt.nl/missions` → 302 `https://www.malt.nl/signin?redirect=/missions` ("Welkom terug!", Google/SSO/e-mail login). `/projects` = 404. Footer heeft geen publieke opdrachten-/missions-pagina.
- Bevestigd in de AGV art. 5.2: "Freelancers hebben toegang tot specifieke functies waarmee zij: … Opdrachtkansen bekijken en beantwoorden." en art. 5.3 opdrachtgevers: "Een Opdracht plaatsen om door Freelancers te worden benaderd." Beide onder "Via hun Account hebben Gebruikers toegang tot de volledige Marketplace".

Conclusie: **opdrachten (client-side postings) zijn niet publiek; alleen freelancer-profielen zijn publiek.**

### Route-probes

| Probe | Resultaat |
|---|---|
| curl (elke URL, ook `/robots.txt`) | 403, `Server: cloudflare`, `cf-mitigated: challenge`, body "Just a moment… Enable JavaScript and cookies to continue" + `<meta name="robots" content="noindex,nofollow">`. Niet omzeild |
| `https://www.malt.nl/robots.txt` (browser) | `User-agent: GPTBot / Disallow: /`; `User-agent: *` disallow o.a. `/s?`, `/s/advanced`, `/search/api`, `/api/`, `/missions`, `/mission/`, `/project-client`, `/project-proposal`, `/signin`, `/profile/api/`, `/profile/public-api/`; `Sitemap: https://www.malt.nl/sitemap.xml`; `FacebookBot Crawl-delay: 5` |
| Sitemap | verwijst naar publieke freelancer-/SEO-pagina's; opdrachten staan achter `/missions` (disallowed + login) |
| JobPosting JSON-LD | n.v.t. — geen publieke opdrachtpagina om te testen |
| `/about/terms` | 404 ("Oeps… De pagina die je zoekt bestaat niet!"); actuele voorwaarden staan op `/legal` |

### Voorwaarden (`https://www.malt.nl/legal`, "Algemene Gebruiks- en Verkoopvoorwaarden van Malt Community", versie 2026-04-16; Malt Community BV, Nederlands recht, rechtbank Rotterdam)

- Art. 3 (toepasselijkheid): bindt "iedere persoon die de Marketplace bezoekt" — ook zonder account.
- Art. 10.1 (IE / databankenrecht): "De Marketplace en alle onderdelen daarvan … zijn het exclusieve eigendom van Malt of haar partners. Deze elementen zijn met name beschermd door het intellectuele-eigendomsrecht, databankenrecht en auteursrecht. Elke reproductie, weergave, gebruik of overdracht, geheel of gedeeltelijk, van de Marketplace of van een van de onderdelen daarvan zonder toestemming van Malt is verboden."
- Art. 10.2 (Verbod op scraping): "Het is strikt verboden om informatie van webpagina's die door Malt worden gehost te extraheren, te verzamelen, over te dragen of te hergebruiken, ongeacht of dit automatisch gebeurt of niet, met behulp van specifieke software, bots of enig ander middel dat met name is ontworpen om gebruikersgegevens die op de Marketplace beschikbaar zijn te scrapen."
- Art. 10.4 (API): "Malt stelt Gebruikers API's ter beschikking … programmeerinterfaces die toegang tot en interoperabiliteit van hun gegevens mogelijk maken." — persoonlijk token, alleen data uit het eigen gebruik van de dienst. **Geen publieke developer-API voor marktbrede opdrachten.**
- Sanctie: schorsing/sluiting account en schadevergoeding.

### Verdict Malt

**LOGIN-ONLY** (opdrachten alleen achter freelancer-account) **+ BLOCKED-ToS** (art. 10.2 verbiedt scraping expliciet, art. 10.1 databankenrecht, robots disallow op `/missions`, Cloudflare-challenge). Een Playwright-login-connector zou art. 10.2 én de accountvoorwaarden schenden; de account-API geeft geen marktbrede opdrachten. Enige legitieme route is een partnerovereenkomst — niet aannemelijk voor een aggregator. **Drop**, effort 0.

## Known gaps

- UWV is niet aangeschreven; of UWV een "goedgekeurde tool"/toestemming verleent aan een commerciële aggregator is onbekend. Gegevensdiensten-criteria (wettelijke taak) lijken niet te passen.
- De Werk.nl Angular-API achter OAM is bewust **niet** verder gereverse-engineerd (art. 13).
- Malt-API-documentatie is alleen zichtbaar na login; niet ingezien. Malt-sitemap niet volledig doorlopen (alleen robots + footer + routes).
- Rate limits op beide bronnen niet gemeten — irrelevant zolang de route geblokkeerd is.

Bewijsbestanden (lokaal, niet gecommit): `~/probes/lane-g/{werk.nl,uwv.nl,data.overheid.nl,malt}/`, `~/probes/lane-g/evidence-report.txt`.
