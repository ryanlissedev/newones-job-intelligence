# Wave · Browser-agent PoC — bewijs eerst dat het kan

Onderzoeksdatum: 2026-09-18. Issues: CTP-505 (parent), CTP-587 (Werk.nl), CTP-541
(Circle8), CTP-552 (Monsterboard), CTP-576 (Freelance.nl), CTP-586 (ICTerGezocht),
CTP-540 (Indeed), CTP-583 (Jellow), CTP-594 (Malt).

**PoC-scope: ToS en robots.txt tellen hier bewust niet mee.** De eerdere
wave-docs waren policy-verdicts ("mag het"); deze PoC meet puur "kan het
technisch". Productie-GO blijft per bron een aparte juridische beslissing —
`te_toetsen` zolang die niet ligt.

## Methode

- Tool: `agent-browser` (Vercel), headed Chrome via CDP, lokaal, geen stealth,
  geen proxies, geen CAPTCHA-solver. Kosten: €0.
- Waarom headed: headless Chrome wordt door Cloudflare/Indeed onmiddellijk
  geweigerd; headed faalt alleen op `headless`-detectie.
- Per bron een verse sessie (Indeed-sessies degraderen snel; hergebruik
  contamineert de meting).

## Gemeten resultaten

| Bron | Eerdere classificatie | Blokkade op curl | Headed browser | Data bereikt |
|---|---|---|---|---|
| Werk.nl | BLOCKED-ToS / GATE-0 | OAM-loginredirect | **direct door** | SPA rendert anoniem; "241.380 vacatures gevonden"; kaarten met titel, bedrijf, contract, uren, opleiding, datum |
| Circle8 | GATE-0 (Vercel-checkpoint op curl) | Vercel-checkpoint | **direct door** | Publieke `/opdrachten`-listing: titel, locatie, duur, uren/week, start, deadline, paginatie (5 pag.) + filters met counts |
| Freelance.nl | DROP-ROBOTS | alleen robots-policy | **direct door** | Publieke listing + detail-links `/opdracht/<id>-<slug>` |
| ICTerGezocht | DROP-ROBOTS | alleen robots-policy | **direct door** | "1.539 ICT vacatures", 31 pagina's, kaarten incl. salaris |
| Indeed | route: Apify | Cloudflare "Blocked" (headless) | **deels** | Eén schone load: 32 kaarten met company/location/salary/jk. Daarna turnstile → auth-loop; `/viewjob?jk=` vereist login |
| Jellow | canceled (Cloudflare) | Cloudflare managed | door de muur heen | Zoeken redirect naar `platform.jellow.nl/register-home` — login-gated, niet geblokkeerd |
| Monsterboard | GATE-0 (DataDome) | redirect → monster.com | **faalt ook headed** | `captcha-delivery.com` (DataDome) device-check; vraagt stealth + solver |
| Malt | LOGIN-ONLY + BLOCKED-ToS | Cloudflare interstitial | **faalt** | Verification blijft hangen (>20 s); opdrachten sowieso login-gated |

## Interpretatie

- **Vier "geblokkeerde" bronnen zijn gewoon publiek leesbaar.** Circle8, werk.nl,
  freelance.nl en ictergezocht.nl stonden op GATE-0/DROP-ROBOTS op basis van
  curl- of policy-metingen. In een echte browser zijn het publieke listings.
- **Werk.nl is de grootste NL-bron die we technisch kunnen bereiken** — ~241k
  eigen vacatures, meer dan Indeed NL qua aanbod.
- **Indeed bevestigt de managed-route.** De eerste load werkt, sessies
  degraderen binnen enkele navigaties. Een browser-agent haalt een pagina,
  geen duurzame pipeline — precies waarom CTP-540 voor Apify koos.
- **Login ≠ blokkade.** Jellow en Malt zijn account-problemen, geen
  anti-bot-problemen. Geen browseragent lost dat op zonder credentials.
- **DataDome (Monsterboard) is een klasse hoger dan Cloudflare.** Headed
  alleen is niet genoeg; stealth/proxy/solver-infrastructuur (Browserbase) is
  nodig — bij laag NL-volume is dat waarschijnlijk geen eigen connector waard.

## Gevolg — drie ingest-niveaus achter hetzelfde Connector-contract

1. **Eigen HTTP-client** (bestaand). Publieke feed/API/JSON-LD/sitemap. €0,
   volledige controle. Blijft de default waar het kan.
2. **Browser-connector** (nieuw, deze PoC-laag). `agent-browser --headed`
   lokaal voor PoC; productie dezelfde CLI met `--provider browserbase`
   (stealth-fingerprint, residential proxies, solver). `discover()`/`fetch()`
   mappen op browser-runs; `fetchUsesNetwork` blijft `true`.
3. **Managed data-API** (Apify actor) voor DataDome-/Indeed-klasse — koopt de
   unblock én de parser.

## Voorgestelde PoC-volgorde

1. **Werk.nl** — grootste catalogus, publiek zonder login, direct bewezen.
2. **Circle8, Freelance.nl, ICTerGezocht** — zelfde patroon (listing-URL →
   pagineren → kaarten + detail-links).
3. **Indeed via Apify** zoals besloten op CTP-540.
4. **Monsterboard** alleen als NL-volume de Browserbase-kosten rechtvaardigt.
5. **Jellow / Malt / MSP-VMS** — account- of partnerwerk, geen scrape-werk.

## Caveats

- PoC-toegang impliceert geen productie-autorisatie. Werk.nl art. 13
  (geautomatiseerd gebruik), Freelance.nl/ICTerGezocht robots-policy en de
  Indeed-robots blijven exact zoals de wave-docs ze vastlegden — de juridische
  beslissing is onveranderd open.
- Headed Chrome lokaal ≠ productie. Sessie-duurzaamheid, rate limits en
  IP-blokkades op schaal zijn niet gemeten; dat hoort bij de connector-PoC.
- `chrome-agent` (captivus) is functioneel equivalent aan de CDP-laag van
  agent-browser; geen reden voor beide.

Bewijs: lokale sessie-logs van de PoC-runs; geen fixtures gecommit (echte
captures volgen pas bij connector-bouw).
