# Freelancer.nl — ingest-recept (geverifieerd 2026-09-16)

Status: **probe afgerond; HTML-connector gebouwd** — dedicated adapter voor
`freelancer.nl`. Dit is nadrukkelijk niet `freelance.nl` en niet CTP-576 Gate0.

## Endpoints

| Doel | URL | Opmerking |
|---|---|---|
| Listing | `GET https://freelancer.nl/opdrachten` | Publieke HTML; eerste pagina bevat 24 unieke detailroutes. |
| Listing vervolg | `GET https://freelancer.nl/opdrachten?page=2` | `page` is 1-indexed; HTML is cumulatief (pagina 2 bevat ongeveer pagina 1 + 2). |
| Detail | `GET https://freelancer.nl/opdrachten/{categorie-of-skills}/{titel}-{8hex}` | De trailing 8-karakter hexwaarde is `bronReferentie`. |

De listing gaf bij de capture `Getoond 1-24 van 100+ resultaten`. De connector
dedupliceert op de trailing hash en stopt wanneer een volgende cumulatieve pagina
geen nieuwe detail-URL's toevoegt. Er geldt een bovengrens van 20 listingpagina's;
als die cap wordt bereikt terwijl de site nog nieuwe pagina's meldt, wordt de run
als `truncated` gemarkeerd.

Categorie-only routes zoals `/opdrachten/archicad` en `/opdrachten/ai`, plus
geo-tussenroutes zonder `-{8hex}`, zijn geen detailrecords en worden genegeerd.

## Veldmapping

| Freelancer.nl HTML | Canoniek / `bronSpecifiek` | Provenance/noot |
|---|---|---|
| `h4.card-title` + `document.location.href` | `titel`, `bronUrl`, `bronReferentie` | Listingkaart; detailreferentie is de trailing 8-char hex. |
| `.info .location` | `locatieTekst` | Voorbeeld: `Remote`. |
| `.info .posted`, `.info .offers` | `bronSpecifiek.geplaatst`, `reacties` | Listing kan relatieve tekst tonen, bijvoorbeeld `Geplaatst 12 uur geleden`. |
| Detail `h1` | `titel` | Voorbeeld: `Designer needed for residential projects`. |
| Label/value `Status` | `bronSpecifiek.status` / lifecycle | `Open` wordt `active`. |
| Label/value `Categorie` | `bronSpecifiek.categorie` | `Design & Creative`. |
| Label/value `Locatie` | `locatieTekst` | `Remote`. |
| `.budget`-blok (listing + detail, `itemprop="baseSalary"`) | `tarief` | Alleen bij expliciete eenheid (`€30 — €40 Per Uur` → 30/40 uur). `Vaste Prijs`/`In overleg` blijft UNKNOWN — een projecttotaal is geen tarief en zou anders ten onrechte `uur` worden gelabeld. |
| Label/value `Soort Budget` | `bronSpecifiek.soort_budget` | `In overleg`; eigen bronlabel als provenance, geen bedrag afgeleid. |
| Label/value `Start` | `startDatum`, `bronSpecifiek.start` | `05-10-2026` wordt `2026-10-05`. |
| Label/value `Verwachte Duur` | `bronSpecifiek.duur`, `bronSpecifiek.verwachte_duur` | `In Overleg`; canonieke sleutel plus bronlabel-provenance. |
| Detail stats `Geplaatst` | `bronSpecifiek.geplaatst` | `15-09-2026`. |
| `Opdracht Omschrijving` description card | `beschrijving` | HTML wordt gestript voor het canonieke tekstveld. |
| Tags onder `Gevraagde Skills` | `bronSpecifiek.skills` | Structured chips, bijvoorbeeld `archicad`, `designer`, `architect`. |

Er is geen JobPosting JSON-LD in de gecontroleerde capture. De connector leest
de expliciete HTML DOM-velden; hij gebruikt geen JSON-LD-paden.

## Robots, voorwaarden en politeness

- `robots.txt`: `User-agent: *` met een lege `Disallow`.
- In de ToS-skim is geen scrapeverbod gevonden; `voorwaardenStatus` blijft
  `te_toetsen` totdat dit formeel is getoetst.
- De bronregistratie gebruikt `crawlDelayMs: 2000` en live requests sturen een
  identificerende, bescheiden User-Agent.

## Voorwaarden

- robots.txt: freelancer.nl: HTTP 200, geen Disallow op connectorpaden (/), geprobed 2026-09-25
- ToS/gebruiksvoorwaarden: zie "Robots, voorwaarden en politeness" hierboven
- Besluit: `te_toetsen`
- Besluitnemer en datum: open voor Robbie (geen besluit vastgelegd)

## Known-hash short-circuit

`listingHashCoversDetail: false`. Een listing-hash kan de detailbeschrijving,
detailstatus, labelvelden en skills niet zien. Daarom geeft de bron geen
`knownHashes` door en mag een gelijk gebleven listing-samenvatting een detail-
fetch niet overslaan (RJC-357/RJC-401).

## Afbakening

`freelancer.nl` is een ander host/product dan `freelance.nl`. CTP-576 Freelance.nl
Gate0 (robots `Disallow:/` en ToS-risico) is hier niet gebruikt en niet gewijzigd.

## Durable ingest-pad (CTP-639, bewezen 2026-09-21)

Freelancer.nl is bewezen op het duurzame ingestpad (`curated.durable_job` +
`POLLER_DURABLE_BRONNEN`) als onderdeel van de L3c mixed-adapter-cohort
(CTM + Flinter + Freelancer.nl + Haert). De connector en source-definitie
zijn ongewijzigd — de migratie is een bewijslast, geen codewijziging.

**Live-probe 2026-09-21:** `https://freelancer.nl/opdrachten` → 200,
~110 KB HTML; de listing is cumulatief gepagineerd (`?page=N`, 1-indexed).

**Resume-contract** (`packages/connectors/src/freelancer-nl/durable-cohort-l3c.spec.ts`,
8 specs): dit is de énige connector in de cohort met een échte pagina-cursor —
`discover()` commit per pagina
`{cursor: <JSON-array van geziene bronReferenties>, page: <volgende pagina>}`.
De seen-set dedupliceert de cumulatieve listing (pagina N bevat pagina 1..N
ongeveer opnieuw). Daardoor hervat een duurzame retake op een gefaalde run
MID-LISTING op het gecommitte checkpoint in plaats van heel vooraan — een
page-2-failure laat `{page:2}` achter en de retake leest pagina 1 nooit
opnieuw. Eerlijk blind-spot: een head-insert op een al gelezen pagina wordt
pas door een verse run gezien, niet door de retake (vastgelegd in de spec).
`listingHashCoversDetail: false` — geen `knownHashes`: de listing-hash ziet
de detailpagina niet, dus elke item kost een detailfetch en een detail-only-
wijziging landt alsnog als `changed`. Bovengrens van 20 listingpagina's; de
cap met meer pagina's resterend markeert de run `truncated`.

**Fixture-corpus (eerlijk):** de committed listing-fixture is de echte
opname (pagina 1 met 3 detailroutes: `56ca9f6b`, `21cdaffd`, `cfc3ced1`),
maar alleen `cfc3ced1` heeft een opgenomen detailpagina. De integratiespec
script daarom een twee-pagina-corpus uit de écht geparse fixture-kaarten:
pagina 1 `cfc3ced1`, pagina 2 `56ca9f6b` — detail-read via de opgenomen
`detail-cfc3ced1.json` (dezelfde recorded-body-per-item-vorm als het
CTP-629-feedcohort voor TenderNed). Elke gepersisteerde payload is een echte
opname.

**End-to-end op de echte pipeline** (fixture-client, `ji_test_iso_*`-Postgres,
`apps/worker/src/poller/l3c-cohort.integration.spec.ts` — 5 specs per bron,
groen): offer → `runDurableBronJobConsumer` → `runBronIngestPipeline` →
observaties, `source_record`s, curated `aanvraag`-rijen en `outbox_event`s;
herhaalde run → alles `unchanged`, geen duplicaten of extra versies;
gewijzigde detail-payload → `changed`-observatie → nieuwe `aanvraag_versie`
+ bijgewerkte curated rij; gefaalde pagina-2-read → run `failed`
(`DISCOVER_FAILED`) op checkpoint `{page:2}` → herval via `reopenFailed`
(fence +1) die op pagina 2 verdergaat zonder pagina 1 te herlezen; abort
mid-item → `failed` (`RAW_STORE_WRITE_FAILED` — persistence-abort is nooit
benign, CTP-490) → retake vanaf het page-checkpoint, exact-één.

**UI-bewijs (geseedde stack):** wegwerp-DB `ji_ctp639_visual_l3c` (door deze
lane aangemaakt), aanvragen gesaaid via het echte duurzame pad met
Manticore-drain (`SEARCH_PROJECTOR=worker`), API `localhost:3000` + web
`localhost:3002` zonder `NEXT_PUBLIC_USE_FIXTURES` (:3001 was door een
operator-SSH-tunnel bezet): `/jobs?source=freelancer-nl&archief=1` rendert
de 2 rijen (`cfc3ced1`, `56ca9f6b`, beide actief) met Bron-chip
`Freelancer.nl`. Captures: `/tmp/ctp639-visual/` (H.264 MP4 + PNG, geopend
en in frame bevestigd).

**Canary en rollback:** `POLLER_DURABLE_BRONNEN` per bron toevoegen, één
tegelijk, ná de CTP-630/CTP-637/CTP-638-cohorten. Rollback = slug uit de
vlag halen; in-flight jobs lopen leeg, geen dubbele scheduling (`main.ts`
returnt voor de inline poll). `FREELANCER_NL_LIVE` blijft uit — dit bewijs
is fixture-only. Operator-canary en release-gate blijven open.
