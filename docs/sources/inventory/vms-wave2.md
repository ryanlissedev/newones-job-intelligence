# Wave 2 · Lane F — VMS/marktplaats-inventaris (CTP-575, CTP-585, CTP-595)

Onderzoek, geen connectorbouw. Alle probes read-only met `curl` (UA `Mozilla/5.0 (compatible; CatapulzeResearch/1.0)`, één request per URL) en headless Chrome voor JS-shells, uitgevoerd **2026-09-17 19:05–19:10 UTC**. Geen logins, geen registraties, geen omzeiling. Geen bronIds toegekend.

Vooraf gecheckt: `docs/SOURCE_MATRIX.md`, `packages/application/src/sources/registry.ts` en `docs/sources/` bevatten geen rij/alias voor OLLiworks, Connecting-Expertise/PIXID of Elanza. Alleen `docs/sources/onefellow.md` noemt "Olliworks-portaal … uitgesloten".

## Verdict-tabel

| Issue | Bron | Verdict | Route | Effort | Aanbeveling |
|---|---|---|---|---|---|
| CTP-575 | OLLiworks / Olli (`olliworks.nl`) | **NO-PUBLIC-SURFACE** (platform); niet ALIAS van Onefellow, maar Onefellow is een Olli-tenant | n.v.t. (per-tenant, als een tenant ooit publiek publiceert) | 0 nu; per tenant ≈ ½ sessie (JSON-LD/SSR) | **Drop** als standalone bron; Olli-tenant-signaal opnemen in werkenbij/per-tenant-discovery |
| CTP-585 | Connecting-Expertise (PIXID Group) | **BLOCKED-ToS** + **LOGIN-ONLY** | Supplier API / schriftelijke toestemming | ≈ 1 sessie ná commerciële toegang | **GATE-0**: alleen na toestemming of Supplier API-contract; NL-volume onbewezen → laag prio |
| CTP-595 | Elanza | **NO-PUBLIC-SURFACE** / **LOGIN-ONLY** | Partner-koppeling (SETU/intermediair) | ≈ 1–2 sessies ná partnerschap; productmatch zwak | **GATE-0**: parkeren; alleen heropenen als zorg-shifts als productcategorie gewenst zijn |

**Voorgestelde Wave 3-bouwlijst uit deze lane: leeg.** Geen van de drie heeft een publiek, ToS-schoon opdrachtenoppervlak. Zie "Wave 3" onderaan voor wat wél te doen.

---

## CTP-575 — OLLiworks / Olli

**Wat het is.** Olli (`www.olliworks.nl`, WordPress/Rank Math, nginx/Plesk, geen Cloudflare) is een NL "Total Talent Management"-product: ATS + VMS + FMS met modules recruitment, flex-compliance, dashboard en een Open API (`/en/features/open-api/`). Het is een softwareleverancier, geen marktplaats met eigen aanbod.

**Publiek oppervlak.**

| Check | Resultaat |
|---|---|
| `https://olliworks.nl` | 301 → `https://www.olliworks.nl/`, 200 |
| `robots.txt` | 200: `User-agent: *` / `Disallow: /wp-admin/` / `Allow: /wp-admin/admin-ajax.php` / `Sitemap: …/sitemap_index.xml` |
| `sitemap_index.xml` | 200 → `post-sitemap.xml` (24), `page-sitemap.xml` (10), `category-sitemap.xml` (3); `/sitemap.xml` 404. Geen opdrachten-/tenant-URL's |
| Publieke opdrachtenlijst | **Nee.** `/vacatures/` toont **1** vacature (`/vacature/hsse-adviseur/`), SSR |
| JSON-LD detail | **Ja**, `JobPosting` met `hiringOrganization` **EQUANS**, `identifier {name: "OLLI ATS", value: "1193"}`, `directApply: true` — het is dus een klant-vacature die via Olli's ATS op olliworks.nl wordt gepubliceerd, geen Olli-eigen vacature |
| Tenant-/subdomeinstructuur | `app.olliworks.nl`, `portal.olliworks.nl` → curl exit 6 (geen DNS); `olliworks.com`, `www.olliworks.com` → exit 7. Geen publieke tenants gevonden; web-search op `site:olliworks.nl opdrachten` / `"powered by olliworks"` leverde geen klant-marktplaats op |
| Loginmuur / IdP | Geen publieke login-URL gevonden; geen IdP waargenomen |
| ToS | `/algemene-voorwaarden/`, `/voorwaarden/`, `/terms/` → 404. `/privacy/` 301 → `/privacy-policy/` (200, alleen "Download hier de privacy verklaring"). PDF `wp-content/uploads/2024/03/privacyverklaring_olli.pdf` (200, 7 p.) niet tekst-extraheerbaar met beschikbare tooling → **geen clausule geclaimd** |

**Relatie met Onefellow.** Olli publiceert de klantcase `/onefellow-neemt-olli-in-gebruik-van-versnippering-naar-een-platform/` ("Met Olli brengt Onefellow urenregistratie, contractmanagement en digitale ondertekening samen in één omgeving"). Onefellows publieke listing draait op een Supabase-edge-function met de naam `olli-jobs` (`docs/sources/onefellow.md`). Onefellow is dus een Olli-**tenant**; de publieke Olli-feed die er is, is al gedekt door de Onefellow-bron. Conform CTP-575 blijft Olli **geen alias** en wordt **niet** in de Onefellow-connector gevouwen.

**Verdict: NO-PUBLIC-SURFACE.** Olli zelf heeft niets te oogsten. Wat Olli-klanten publiceren, leeft op hún domein (zoals Onefellow) en wordt per klant als eigen bron beoordeeld. Aanbeveling: CTP-575 sluiten als "drop, per-tenant heroverwegen"; de identifier `OLLI ATS` in JobPosting-JSON-LD is een bruikbaar fingerprint om toekomstige Olli-tenants te herkennen in werkenbij-/JSON-LD-discovery.

---

## CTP-585 — Connecting-Expertise (PIXID Group)

**Wat het is.** Belgische VMS + marktplaats (Antwerpen, sinds 2007, onderdeel PIXID SAS). Eigen JSON-LD noemt klanten ENGIE, Belfius, bpost, ING, BASF, Vlaamse Overheid; `areaServed` BE/NL/LU/FR/DE; "+6.500 actieve suppliers". `pixid.nl` en `pixid.fr` zijn PIXID-marketingsites zonder opdrachtenlijst. **NL-volume: geen enkel NL-signaal gevonden** — alle genoemde klanten zijn Belgisch.

**Publiek oppervlak.**

| Check | Resultaat |
|---|---|
| `www.connecting-expertise.com` | 200, Webflow SSR, `server: cloudflare` (passief, geen challenge) |
| `robots.txt` | 200: `User-agent: *` met `Disallow` op `/?trk=`, `/?s=`, `/?language=`, `/?cat=`, `/resources?filter=`; `Sitemap: /sitemap.xml` |
| `sitemap.xml` | 200, **144 URL's** (marketing, `/marketplace`, `/freelancers`, `/workforce-suppliers`, `/api-for-suppliers`, `/login-page`, `/terms-of-use`); geen opdracht-URL's |
| `/marketplace`, `/nl/marketplace` | 200; credit-koopflow ("koop een credit → publiceer aanvraag → ontvang voorstellen"). JSON-LD `Service` + `FAQPage`. **0 opdrachten** |
| `/vacancies-vrt` | 200; enige publieke lijst: **3 rollen** (Engineer Radio Audio, Engineer TV Studio, Audio/Video Equipment Manager) voor VRT (MSP: Solvus); "View all vacancies" → registratie. **Geen** `JobPosting` JSON-LD |
| Loginmuur / IdP | `customer.connecting-expertise.com/index.php?event=contractor.login` 200, eigen "Contractor login" user/pass-formulier (Apache); `app.connecting-expertise.com` app-shell. Geen externe IdP waargenomen |
| Tenants | `marketplace.`, `portal.`, `supplier(s).`, `connect.` → geen DNS. Geen klant-tenants; VRT-pagina is een landingspagina op de hoofdsite |

**ToS — `https://www.connecting-expertise.com/terms-of-use` (EN; NL-versie op `/nl/terms-of-use`, niet woordelijk vergeleken), opgehaald 2026-09-17:**

> §7 *Limitation of use*: "Users shall not, directly or indirectly, attempt to gain unauthorised access to the platform, user accounts or any confidential information. Examples include, but are not limited to, phishing, spamming, **scrapings activities**, the use of malware / spyware, any activity likely to disrupt or harm the functionality of the Connecting-Expertise platform, …"
>
> §8 *Restrictions on Use*: "**Copy, reproduce, record, make available to the public or otherwise use any part of the Connecting-Expertise platform or its content** in any way not expressly authorised by this agreement."
>
> §8 *Restrictions on Use*: "**Use any functionality of the Connecting-Expertise platform using a script or other automated process (e.g. using software robots, web crawlers, ...) without prior and explicit approval** by Connecting-Expertise."
>
> §10 *Intellectual property*: "You acknowledge and agree that our VMS platform, including but not limited to, software, applications, user interfaces, designs, trademarks, logos and other content, are protected by intellectual property laws (including but not limited to copyright), and belong to our company."

Geen aparte databankrecht-clausule. De ToS definieert het platform als "our vendor management system and marketplace, accessible via our website or various api's" — de clausules dekken dus ook de publieke marketing-/VRT-pagina's.

**Verdict: BLOCKED-ToS + LOGIN-ONLY → GATE-0.** Zelfs de 3 publieke VRT-rollen vallen onder een expliciet crawl-/kopieerverbod, vergelijkbaar met Randstad Enterprise §3.3 (reeds "overslaan"). Enige legitieme route: (a) schriftelijke toestemming, of (b) het **Supplier API-programma** (`/api-for-suppliers`) als gecontracteerde leverancier — commercieel besluit. Gezien 0 NL-signaal en BE-focus: laag prio; aanbeveling **drop tenzij een NL-klant van CE opduikt**. PIXID-VMS zelf (FR) heeft geen NL-oppervlak; "één bron bij zelfde stack" (CTP-585) blijft van toepassing als ooit gebouwd.

---

## CTP-595 — Elanza

**Wat het is.** NL zorg-flexplanning ("Slimme software voor planning van flexibele zorgverleners"): planning, kwaliteit/compliance en facturatie van eigen flexpools, regiopools, zzp'ers en uitzendbureaus voor VVT/GGZ/GHZ. Eenheid is een **dienst/shift**, geen interim-opdracht. Klanten o.a. Alliade, Argos, Sint Jacob, Happy Nurse, iGen; integraties AFAS, Youforce, Nedap ONS, Ortec OWS; "Elanza koppelt met intermediairs" via SETU.

**Publiek oppervlak.**

| Check | Resultaat |
|---|---|
| `elanza.nl` | 200, Framer SSR (`server: Framer/…`); `www.` 308 → apex |
| `robots.txt` | 200: `User-agent: *` / `Allow: /` / `Sitemap: https://elanza.nl/sitemap.xml` |
| `sitemap.xml` | 200, **52 URL's**: platform, oplossingen, partners, klanten, nieuws, legal, 4 corporate `werken-bij`-vacatures. **Geen** opdrachten/diensten |
| Publieke opdrachten-/dienstenlijst | **Nee.** `app.`, `mijn.`, `portal.`, `marketplace.`, `api.`, `partner(s).elanza.nl` → allemaal 200 met **dezelfde JS-app-shell** ("Je hebt javascript nodig om deze website te bekijken", `window.__ELANZA_CONFIG__` v0.16.7, `server: Google Frontend`); headless render toont alleen een spinner. `/api`, `/docs`, `/swagger` → zelfde shell |
| JSON-LD | Geen `JobPosting` op marketing- of `werken-bij`-pagina's (corporate vacatures Elanza zelf) |
| Loginmuur / IdP | App-shell, geen redirect en geen zichtbaar loginformulier in SSR; IdP niet vaststelbaar zonder JS-interactie — **niet geïnfereerd** |
| Tenants | Subdomeinen lijken catch-all naar één app; geen publieke klant-tenants |
| ToS | Geen gebruiksvoorwaarden gepubliceerd. `legal/privacy-policy`: "Dit privacy statement is nadrukkelijk niet van toepassing op de door ons geleverde software oplossingen." `legal/responsible-disclosure-policy` scoopt onderzoek op `https://app.elanza.nl` en vraagt "Do not take advantage of the vulnerability … by downloading more data than necessary". Geen scraping-/databankclausule |

**Verdict: NO-PUBLIC-SURFACE / LOGIN-ONLY → GATE-0.** Aanbod bestaat alleen binnen de gesloten app, per zorginstelling, en is shift-gebaseerd. Toegang zou lopen via een bureau-/intermediair-koppeling (SETU) of een zzp-account — een partnerschapsbesluit, en de productmatch met "opdrachten voor ICT/interim-professionals" is zwak. Aanbeveling: **parkeren**; alleen heropenen als zorg-shifts een gewenste productcategorie worden (dan samen met ZiP-peers als categorie beoordelen, niet Elanza solo).

---

## GATE-0 (legal/commercieel besluit nodig)

1. **Connecting-Expertise**: toestemming vragen of Supplier API-contract aangaan? Zonder dat: niet aanraken (ToS §7/§8).
2. **Elanza**: willen we zorg-shifts als categorie? Zo ja: partnerroute via intermediair-koppeling; zo nee: sluiten.
3. **Olli**: geen besluit nodig; wel afspreken dat Olli-tenants per klantdomein worden beoordeeld (Onefellow-precedent).

## Wave 3 — voorstel uit deze lane

Geen bouwkandidaten. Wél twee goedkope vervolgacties:

- **Olli-tenant-fingerprint** in de werkenbij/JSON-LD-discovery: `identifier.name == "OLLI ATS"` markeert een Olli-klant; nieuwe tenants met publieke opdrachten dan als eigen bron opvoeren (½ sessie per tenant, JSON-LD-route).
- **CTP-575/585/595 sluiten** met verwijzing naar dit document; heropenen alleen op GATE-0-besluit.

## Bekende gaten

- Olli-privacy-PDF niet tekst-extraheerbaar; inhoud niet beoordeeld (waarschijnlijk alleen AVG, geen ToS).
- Elanza-IdP niet vastgesteld (geen JS-interactie uitgevoerd, conform read-only-scope).
- Connecting-Expertise NL-volume niet kwantificeerbaar zonder account; oordeel "laag" is op basis van publiek klantenlijstje.
- Ruwe probe-output (headers, bodies, timestamps) is niet gecommit; samenvattingen met HTTP-codes staan hierboven en als commentaar op de Linear-issues.
