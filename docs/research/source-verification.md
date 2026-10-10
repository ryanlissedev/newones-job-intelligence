# Bronverificatie — bewijs achter `../SOURCE_MATRIX.md`

Datum 2026-08-27. Read-only: headless Chrome (chrome-agent/CDP) + curl met beschrijvende UA; geen logins, geen omzeiling, één request per pagina. Drie batches + TenderNed (zie `../sources/tenderned.md`).

## Batch 1 — MSP/broker

| Bron | Listing (opgelost) | Publiek | Login/auth | robots | Voorwaarden | Tech | Verdict |
|---|---|---|---|---|---|---|---|
| Staffing MS | staffingms.com → headfirst.nl/staffingms/; listing = striive.com/nl/opdrachten | deels — 124 (titel, opdrachtgever, plaats, provincie); detail/reageren via account | login.striive.com → auth.striive.com/u/login (Auth0); leverancier: striive.com/en/suppliers/how-it-works | headfirst `Allow: /`; striive `Disallow:` leeg | striive.com/nl/algemene-voorwaarden art. 4.6 "technische voorzieningen … niet omzeilen"; leveranciersvoorwaarden geen clausule | server-rendered; JSON-LD WebPage only; Apache, geen CF | account (details) / HTTP (lijst) |
| Circle8 | circle8.nl — curl 429, headless 403; tenants htm./portal./fudura.circle8.nl | ONGEVERIFIEERD | htm.circle8.nl/registreren (200); portal.circle8.nl **TLS verlopen** | ONGEVERIFIEERD (challenge) | inkoopvoorwaarden 429 | **Vercel Security Checkpoint** `x-vercel-mitigated: challenge` | anti-bot + account → Browserbase/handmatig |
| BlueTrail | bluetrail.nl/opdrachten/ | ja — 14; detail: sluitingsdatum, start, uren; geen tarief | /inloggen-professionals/ (Gravity Forms + reCAPTCHA); /aanmelden-leveranciers/ = 404 | `Disallow: /opdrachten/*or-`, `*?order=`, `*?_sft_` | alleen cookie/privacy | JSON-LD JobPosting; WordPress; sitemap | public-ok → HTTP |
| Harvey Nash NL | harveynash.nl/vacatures | ja — 15; tarief, deadline, locatie, uren, start | geen leverancierslogin | `Allow: /` | geen voorwaarden | JSON-LD; in-page `/_sf/api/v1/jobs/search.json` (401 direct); CloudFront/S3; Bullhorn | public-ok → HTTP |
| Between | between.nl → headfirst.nl/between/; = Striive | = Staffing MS | = idem | = idem | = idem | = idem | dedupe met SMS → Striive |
| Brainnet | brainnet.nl → magnitglobal.com/nl (Magnit) | nee | magnit.my.site.com/vms/s/login (Salesforce); legacy prowand.pro-unlimited.com | `Allow: /`, `Disallow: /content/*` | alleen privacy | Cloudflare edge, geen challenge; JS-SPA | account → Playwright-login |
| Hero | **hero.eu**/en/interim-opdrachten (hero.nl = onverwant Drupal) | ja — 61; regio, werkvorm, uren, client; geen tarief/deadline | hero.eu/auth/login (Next.js, Google + LinkedIn) | `Disallow: /api/`, `/auth/`, `/onboarding/`; `Allow` GPTBot/ClaudeBot | alleen privacy | JSON-LD; Next.js RSC | public-ok → HTTP |

## Batch 2 — MSP/broker

| Bron | Listing | Publiek | Login | robots | Voorwaarden | Tech | Verdict |
|---|---|---|---|---|---|---|---|
| Bconnect | bconnect.nl **geparkeerd** ("Dovendi"); BlueTrail-dochter → bluetrail.nl/opdrachten/ | ja — 175 | = BlueTrail | `Crawl-delay: 5` + filter-disallows | geen AV | JSON-LD; job-sitemap.xml | = BlueTrail |
| Flinter | flinter.nl/opdrachten | ja — titel, locatie, duur, opdrachtgever | flinter.flexportal.eu (Textkernel) | site leeg; portaal `Disallow: /` | AV: alleen IE | geen JSON-LD; PHP | public-ok → HTTP |
| StaffingNow | staffingnow.nl/opdrachten/ leeg; jobs.staffingnow.nl 302 → /Account/Login | nee | eigen form (Blazor) + REGISTREREN | `Disallow: /` voor GPTBot/Ahrefs/Semrush/Bing (niet `*`) | alleen privacy | WordPress RSS (blog) | account → Playwright-login |
| Need Staffing IT | needstaffing.nl/Opdrachten (esd.next) | ja — 63; detail: **tariefband €85–93, deadline 03-09 14:00**, uren, duur | needstaffing.esdnext.com/app (eigen) | leeg; esdnext Cloudflare-boilerplate | alleen privacy | .NET server-rendered; CF passief | public-ok → HTTP |
| Onefellow | onefellow.nl/opdrachten | ja — 39; ref#, start, deadline | portal.onefellow.olliworks.app; zelfregistratie `/pub/supplier/registration/quick` | `Allow: /`; olliworks `Disallow: /` | /voorwaarden geen clausule | **Supabase edge `…/functions/v1/olli-jobs?action=list`** (waargenomen zonder auth); JSON-LD ItemList; `__cf_bm` | API/feed (verifiëren) |
| OneStopSourcing | onestopsourcing.nl **geen A-record** (NS transip) | ONGEVERIFIEERD | esd.next-platform (uit snippet) | — | — | — | later; = Need Staffing-connector |
| Pro-Act IT | pro-act.nl/vacatures/ | ja; detail: einddatum, inzet, tarief "marktconform" | geen portaal; Reageer-form (Bullhorn/Herefish) | `Crawl-delay: 10`; sitemap_index | Inkoopvoorwaarden 2023 PDF: alleen IE | JSON-LD; vacancy-sitemap.xml; WordPress | public-ok → HTTP |

## Batch 3 — VMS / tender / overheid

| Bron | Listing | Publiek | Login | robots | Voorwaarden | Tech | Verdict |
|---|---|---|---|---|---|---|---|
| Magnit | geen; portaal magnit.my.site.com/vms/s/login | nee | Salesforce; prospect-registratie eu.workforcelogiq.com/supplierprospect (reCAPTCHA) → Magnit keurt/nodigt uit; Supplier API alleen gecontracteerd | `Disallow: /content/*` | compliance-policies (clausule ongeverifieerd); Supplier CoC PDF | Salesforce Aura | invitation-only |
| Randstad Enterprise | geen; rsrsupplierportal.my.site.com | nee | Salesforce + SSO; geen zelfregistratie | SEO-params | **T&C §3.3: "automated searches, spidering, using intelligent agents, … harvesting" verboden** | Drupal; OneTrust | **overslaan** |
| Mercell s2c (ex-Negometrix) | s2c.mercell.com/today | ja — 1.154 open, 116 pag.; titel, aanbestedende dienst; detail/docs via account | identity.s2c.mercell.com (OIDC), gratis registratie | **`Disallow: /`** hele site | mercell.com T&C → trust.mercell.com (ongeverifieerd) | Angular; POST api.s2c.mercell.com/api/v1/PublishedTender/GetPublishedTendersBySpecified (unauth in-page) | ToS-besluit; boven-drempel = TenderNed |
| DigiInhuur | **bestaat niet** (digiinhuur.nl resolvet niet; 2018 Rijk/Fieldglass-project) → DioR digitale-inhuuroplossing-rijk.my.site.com | nee | Salesforce + SSO; Register voor leveranciers | `Allow: /` | geen | Salesforce Aura | account, lage prio |
| Inhuurdesk (Staffing MS-product) | inhuurdesk.nl/aanvragen/ | ja — 29; titel, opdrachtgever, locatie, uren, start, looptijd, sluitingsdatum, aanvraagnummer, segment, rolomschrijving, tarief in tekst | staffingdesk.my.site.com (Salesforce), zelfregistratie; sommige klanten via login.striive.com | `Disallow:` leeg; sitemap_index | ToU-PDF okt 2023: geen scrap/bot/crawl-clausule | **`GET /wp-json/headfirst-assignments/search`** `{total,data[]}`; RSS `/aanvragen/feed/`; JSON-LD; PDF per item | API/feed — beste van de zes |
| CTM Solution | ctmsolution.nl → info.mercell.com; platform eu.eu-supply.com/ctm/supplier/publictenders?B=CTMSOLUTION | ja — 26; aanvraagnr, referentie, titel, publicatie, sluitingstijd, procedure, organisatie, land, CPV | rwlentrance_s.asp; gratis registratie | listing niet disallowed | auction_rules.asp redirect-loop | ASP.NET; **Atom `…/ctm/rss/Rss.ashx?days=30&b=CTMSOLUTION`** met `<publication>`-XML | API/feed |

## TenderNed-cross-check (republish)

`search=<titel>&sort=relevantie&publicatieDatumPreset=AF30`: **5/5 gevonden** — CTM/Anculus "onderhoud blusmiddelen en noodverlichting" (437175/607965 én 436758/607333), Mercell "Centrale stemopneming verkiezingen" Gemeente Amsterdam (437349/608282), "Bestek 2580 N317" Provincie Gelderland (437256/608110), Waterschap Scheldestromen (437338/608263), Stedin (437188/607978). Conclusie: boven-drempel Mercell/CTM ⇒ dezelfde dag op TenderNed; DAS-minicompetities en onderdrempelige rondes níet.

## Dwarsdoorsnede

Geen DataDome/Akamai op enige bereikbare bron; één Vercel-challenge (Circle8); Cloudflare passief bij Onefellow/esdnext. Geen expliciete anti-scraping-clausule behalve Randstad §3.3; StaffingNow's GPTBot-blokkade is het enige AI-crawler-signaal. Crawl-delays: BlueTrail 5 s, Pro-Act 10 s.
