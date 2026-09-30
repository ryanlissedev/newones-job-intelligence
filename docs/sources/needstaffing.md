# Need Staffing — ingest-recept (geverifieerd 2026-08-31)

Status: **probe afgerond; connector nog niet gebouwd** — adapter-categorie `html`; volume 63. Geen Cloudflare-challenge; overige velddekking en voorwaardenstatus zijn niet vastgesteld in de aangeleverde probe.

## Endpoints

| Doel | URL | Opmerking |
|---|---|---|
| Listing | `GET https://www.needstaffing.nl/Opdrachten` | Server-rendered, ongeveer 20 opdrachten per pagina met paginering. |
| Detail | `GET https://www.needstaffing.nl/Opdrachten/{id}` | Server-rendered; sample-ids `15520` (2026-08-31, truncated body) en elke rij van de listing-capture van 2026-09-16 (`listing-live-2026-09-16.json`; details `detail-<id>.json`, o.a. `15599`). |

Er is in de probe geen JSON-endpoint, JSON-LD of sitemap aangetroffen.

## Veldmapping → canoniek `aanvraag`

| Need Staffing | Canoniek | Provenance/noot |
|---|---|---|
| detailtitel | `titel` | Server-rendered detail. |
| referentie in titel | `bron_referentie` | Sample bevat `2026-BZB-0457`. |
| tariefband | `tarief_min`, `tarief_max` | Sample bevat `€98-102`. |
| detail-URL `{id}` | `bron_url` | Sample-id `15520`. |
| "Locatie"-icoonveld (vóór de `/` of vóór `(...)`) | `locatie_tekst` | Combineert stad+werkvorm in één veld; zie hieronder. |
| "Locatie"-icoonveld (na de `/` of binnen `(...)`), alleen als die tweede helft een werkvorm-woord bevat (`/hybride\|remote\|thuis\|locatie\|kantoor\|afstand/iu`) | `bronSpecifiek.werkvorm` | Live 2026-09-16 (`detail-15599.json`): `"Den Haag/Hybride"` → locatie `Den Haag`, werkvorm `Hybride`. Bredere listing-capture toont ook `"Maasland (volledig op locatie)"`, `"Huis ter Heide (2 dagen op locatie)"`, `"Utrecht (op locatie)"` — vrije tekst zoals gepubliceerd, geen canonicalisatie (CTP-514 F07 staat vrije tekst toe). De keyword-gate voorkomt dat een tweede stad (`"Utrecht/Amersfoort"`) of een wijknaam (`"Amsterdam (Zuidas)"`) ten onrechte als werkvorm wordt gelezen (advisor review) — in dat geval blijft de hele string `locatie` en blijft werkvorm afwezig, net als wanneer de `/`- of `(...)`-vorm helemaal ontbreekt. |
| `<h2>Competenties</h2>` gevolgd door `<ul><li>...</li></ul>` in de vacancy-body | `bronSpecifiek.skills` | Live 2026-09-16 (joborder 15599): `Eigenaarschap`, `Overtuigingskracht`, `Inhoudelijke scherpte`, `Analytisch sterk`, … (13 items). Alleen deze gestructureerde lijst — nooit vrije-tekst mining van de "Eisen"/"Gewenste kennis"-secties. |
| "Verwacht aantal uren per week" | `bronSpecifiek.uren`, `uren_per_week` | Vorm wisselt: `"36"` (2026-08-31) vs `"36u"` (2026-09-16) — alleen het leidende getal/de range wordt bewaard, de eenheidstekst niet. |
| `periode` | `bronSpecifiek.duur` | Geen apart einddatumveld aangetroffen op de header of in de getypeerde detail-shape, dus altijd `duur`, nooit `eind_datum`. |

Opdrachtgever en deadline zijn eerder vastgesteld (zie Sluitingsdatum hieronder). Niveau (opleidingsniveau) staat NIET als los, gestructureerd veld op de pagina — het zit alleen ingebed in een volzin binnen de "Eisen"-lijst (bv. "Minimaal een afgeronde HBO-opleiding."). Dat vergt vrije-tekst mining (GAP_ENRICH, CTP-482) en is hier bewust niet geïmplementeerd. F10 startdatum: bevestigd correct op twee live records (15520 én 15599) — `data-date-utc` is bij Need Staffing UTC-middernacht van de weergegeven datum, dus geen Europe/Amsterdam-verschuivingsbug zoals bij Onefellow.

## Ingest-patroon

- Fetch de SSR-listing, volg de paginering en ontdek de detail-URL's.
- Parse titel, referentie en tariefband uit iedere server-rendered detailpagina.
- Gebruik geen API-route: er is geen endpoint in de probe genoemd. Cloudflare was passief en serveerde geen challenge.

## Licentie en voorwaarden

- Er is geen `robots.txt` aangetroffen; daardoor is ook geen crawl-delay uit de probe beschikbaar.
- ToS/licentie is niet opgenomen in de aangeleverde probe. Houd `voorwaarden_status: te_toetsen` vóór activatie.

## Risico's

1. Zonder sitemap is listingpaginering de enige geprobeerde discovery-route.
2. Er is geen gestructureerde JSON-LD- of API-fallback.
3. Velddekking buiten titel, referentie en tariefband is niet vastgesteld.

## Sluitingsdatum (RJC-377)

De detailpagina publiceert een echte, per-opdracht sluitingsmoment: het "Deadline voor reageren"-blok (`data-date-utc`, epoch-ms met tijdcomponent — live capture 2026-08-31, `fixtures/connectors/needstaffing/detail-15520.json`). Vóór RJC-377 werd dit veld wel geparsed naar `bronSpecifiek.deadline` maar nooit gebruikt om de lifecycle te sluiten, waardoor elke Need Staffing-aanvraag voor altijd "actief" bleef. `sluitingsdatumPassed` wordt nu op volle instant-precisie (niet afgekapt op datum) tegen dit veld berekend, zodat een deadline later op de dag van vandaag niet te vroeg sluit (RJC-376-discipline).

## Known-hash short-circuit (RJC-357 / RJC-401)

`listingHashCoversDetail: false` — de fetch parset de detail-HTML en de normaliser leest daaruit velden (titel, beschrijving, tarief) die op de detailpagina kunnen wijzigen terwijl de listing-rij (en dus de listing-hash) gelijk blijft. Geen `knownHashes`-store doorgegeven (afgedwongen in `sources.spec.ts`).

## Durable cohort (CTP-640, bewezen 2026-09-25)

Need Staffing IT is bewezen op het duurzame ingestpad (`curated.durable_job`
+ `POLLER_DURABLE_BRONNEN`) als onderdeel van de L3d mixed-adapter-cohort
(Harvey Nash + Hays + Need Staffing IT + Onefellow). De connector en
source-definitie zijn ongewijzigd — de migratie is een bewijslast, geen
codewijziging.

**Live-probe 2026-09-25:** `https://www.needstaffing.nl/Opdrachten?PageNumber=1&SortOrder=NewestFirst`
→ 200, ~87 KB HTML-listing.

**Resume-contract** (`packages/connectors/src/needstaffing/durable-cohort-l3d.spec.ts`,
7 specs): dit is een van de twee cohortleden mét een echte pagina-cursor —
`{page}` op `/Opdrachten?PageNumber=N+1`, gedreven door `hasNextPage` (cap
20). Een duurzame herval HERVAT op de gecommitte pagina: pagina's achter
de cursor worden nooit herlezen en hun items niet opnieuw opgehaald —
exact-één draait daar op de cursor, niet op de replay key. Een head-insert
op een al-gelezen pagina is onzichtbaar voor de herval (read-pages blind
spot; herstelt op de volgende verse poll), en een herval rapporteert
`complete: false, reason: "resumed"` zodat de missed-poll-reconcile hem
overslaat. `knownHashes` wordt bewust níét doorgegeven
(`listingHashCoversDetail: false`): een listing-hash-skip zou detail-only
wijzigingen op `/Opdrachten/{id}` bevriezen. Cap-overschrijding markeert
`truncated`, nooit stilletjes compleet.

**Fixture-corpus (eerlijk):** de committed listing-fixtures zijn echte
opnamen — `listing-page-0.json` (1 kaart) en `listing-live-2026-09-16.json`
(20 kaarten), met 21 detail-fixtures (`detail-15520` … `detail-15601`). De
integratiespec servert een gescript twee-pagina-corpus uit de echte live
fixture-items (15574 op pagina 0, 15601 op pagina 1), beide detail-backed,
zodat de `{page:1}`-checkpoint een echte mid-listing-herval afdwingt. Geen
opgenomen reject-fixture.

**End-to-end op de echte pipeline** (fixture-client, `ji_test_iso_*`-Postgres,
`apps/worker/src/poller/l3d-cohort.integration.spec.ts` — 5 specs per bron,
groen): offer → `runDurableBronJobConsumer` → `runBronIngestPipeline` →
observaties, `source_record`s, curated `aanvraag`-rijen en `outbox_event`s;
herhaalde run → `unchanged`; gewijzigde detail-titel → `changed` → nieuwe
`aanvraag_versie` + bijgewerkte curated rij; gefaalde page-1-listing-read →
run `failed` (`DISCOVER_FAILED`) mét gecommitte cursor `{page:1}` → herval
via `reopenFailed` (fence +1) hervat op pagina 1 zonder page 0 te herlezen;
abort mid-item op pagina 1 → `failed` (`RAW_STORE_WRITE_FAILED`, CTP-490)
met dezelfde gecommitte cursor → retake hervat mid-listing, exact-één.

**UI-bewijs (geseedde stack):** wegwerp-DB `ji_ctp640_visual_l3d` (door deze
lane aangemaakt), aanvragen gesaaid via het echte duurzame pad met
Manticore-drain (`SEARCH_PROJECTOR=worker`), API `localhost:3000` + web
`localhost:3001` zonder `NEXT_PUBLIC_USE_FIXTURES`: `/jobs` toont de
Bron-facet met alle vier de bronnen incl. tellen. De opnames zijn ouder
dan hun sluitingsdatum, dus de pipeline zette de 20 rijen terecht op
`closed`; voor de capture zijn de geseedde curated rijen op `active` met
een toekomstige sluitingsdatum gezet en opnieuw geprojecteerd — fixtures
ongewijzigd, alleen weergavestaat. Captures: `/tmp/ctp640-visual/` (H.264
MP4 + PNG, geopend en in frame bevestigd).

**Canary en rollback:** `POLLER_DURABLE_BRONNEN` per bron toevoegen, één
tegelijk, ná de L3a/L3b/L3c-cohorten. Rollback = slug uit de vlag halen;
in-flight jobs lopen leeg, geen dubbele scheduling. `NEEDSTAFFING_LIVE`
blijft uit — dit bewijs is fixture-only. Operator-canary en release-gate
blijven open.
