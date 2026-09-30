# Harvey Nash NL — ingest-recept (geverifieerd 2026-08-31)

Status: **probe afgerond; connector nog niet gebouwd** — adapter-categorie `json-api` met `json-ld`-fallback; 30 live opdrachten. Geen technische blocker; privé-API-risico en voorwaardenstatus blijven expliciet.

## Endpoints

| Doel | URL | Opmerking |
|---|---|---|
| Listing | `GET https://www.harveynash.nl/vacatures` | Client-rendered; 15 resultaten per pagina. |
| JSON-search | `POST https://www.harveynash.nl/_sf/api/v1/jobs/search.json` | Body bevat `offset` en `jobs_per_page`; geen auth-header waargenomen. |
| Sitemap | `GET https://www.harveynash.nl/sitemap.xml` | Bevat vacature-URL's en enkele niet-jobpagina's. |
| Detail/fallback | `GET https://www.harveynash.nl/vacatures/<numericId>-<slug>` | SSR met JobPosting JSON-LD en gelabelde tekst. |

## Privé-API

Besluit Ryan, 2026-08-31: ongedocumenteerde JSON-endpoints MOGEN gebruikt worden, met een expliciete fallback naar SSR/JSON-LD, en elke bron die zo'n endpoint gebruikt moet in zijn doc vermelden dat het een privé, ongedocumenteerd API is dat zonder waarschuwing kan wijzigen.

Voor Harvey Nash is dit een ongedocumenteerd, privé endpoint; het kan zonder waarschuwing wijzigen. Fallback: sitemap → SSR-detail → JobPosting JSON-LD, aangevuld met de zichtbare gelabelde tekst.

## Veldmapping → canoniek `aanvraag`

| Harvey Nash | Canoniek | Provenance/noot |
|---|---|---|
| `job.id`, `external_reference` | `bron_referentie`, `bron_specifiek.externe_referentie` | JSON-search. |
| `job.title`, `description` | `titel`, `beschrijving` | JSON-search; beschrijving is HTML. |
| `addresses`, `derived_info.locations` | `locatie_omschrijving`, `bron_specifiek.geo` | JSON-search. |
| categorie `Clients` | `opdrachtgever_naam` | JSON-search. |
| gelabelde beschrijvingstekst | `uren_per_week`, `tarief_tekst`, `startdatum`, `sluitingsdatum` | Detail/API-beschrijving. |
| `published_at`, `expires_at`, `updated_at` | `gepubliceerd_op`, `vervalt_op`, `bron_bijgewerkt_op` | Unix-tijden uit JSON-search. |
| JobPosting `baseSalary` | **niet overnemen** | GBP/YEAR met vrije tarieftekst; semantisch garbage. |

Consultantnaam, consultant-e-mail en consultantcategorie worden niet genormaliseerd of gelogd.

## Ingest-patroon

- POST de geobserveerde search-body en page met `offset`; voor 30 records zijn twee requests van 15 nodig.
- Parse het gelabelde blok in `description` voor uren, tarief, start en deadline.
- Gebruik sitemap/detail-JSON-LD als fallback/verifier en houd de pollfrequentie terughoudend.

## Licentie en voorwaarden

- `robots.txt` staat alles toe, noemt de sitemap en heeft geen crawl-delay.
- Een gebruikslicentie of bruikbare ToS-uitkomst staat niet in de probe. Houd `voorwaarden_status: te_toetsen` vóór activatie.

## Risico's

1. Het private endpoint kan zonder aankondiging wijzigen of verdwijnen.
2. Gestructureerde salarisvelden zijn onbruikbaar voor tariefnormalisatie.
3. De deadline in de zichtbare tekst kan een jaartal missen.

## Sluitingsdatum (RJC-377, herzien na Fable-review)

Er staan twee verschillende data in elke listing: de vrije tekst "Deadline voor het voorstellen van kandidaten" (`detail.facts.deadline`) en `jsonLd.validThrough` (de eigen geldigheidsdatum van de JobPosting, komt exact overeen met de search-listing's `expires_at` unix-tijd — bevestigd live 2026-08-31). Eerdere framing noemde `facts.deadline` "leverancier-intern" en gebruikte `validThrough` als het Striive-`closingDateClient`-analogon (RJC-376) — dat was onjuist: voor dit product is de kandidaat-inleverdeadline juist het moment waarop de aanvraag voor een Catapulze-gebruiker niet meer actionable is, dus `facts.deadline` is het echte analogon van `closingDateClient`, niet `validThrough`.

**Toegepast (CTP-519, F13):** `sluitingsdatum` gebruikt nu de resolved `facts.deadline` wanneer die niet `UNKNOWN` is, en valt alleen terug op `validThrough` wanneer de vrije-tekst deadline zelf niet oplosbaar was (`resolveHarveyNashDeadline` gaf `UNKNOWN`). Een onbekende deadline mag nog steeds nooit als "al gesloten" gelezen worden — de fallback-volgorde behoudt dat gedrag. De twee data kunnen uiteenlopen (in de fixture: deadline "04-09" vs. validThrough "2026-09-07"); zie `packages/application/src/normalise/harveynash.ts` (`sluitingsdatumRaw`) en de bijbehorende tests in `harveynash.spec.ts`.

## Overige CTP-519 veldmapping-fixes

- **F04 provincie** — `bronSpecifiek.provincie` via `findProvincieInText(detail.facts.locatie)` (bv. "Bunnik , Utrecht" → `"Utrecht"`); `null` wanneer de locatietekst geen erkende provincie noemt.
- **F09 tarief eenheid** — `parseHarveyNashRichttarief` herkent nu ook "all-in"/"ex btw"/"excl. btw"/"exclusief btw" als het Nederlandse inhuur-uurtarief-conventie (zelfde tokenset als `normalise/tarief.ts`'s `detectEenheid`), niet alleen de letterlijke woorden "uur"/"dag"/"maand".
- **F11 eind/duur** — `bronSpecifiek.duur` (bv. `"24 maanden"`) geëxtraheerd uit het gelabelde "Duur van de opdracht:" paragraaf in `jsonLd.description`; `bronSpecifiek.eind_datum` blijft `null` (Harvey Nash publiceert nooit een expliciete einddatum, alleen een looptijd).
- **F07 werkvorm** — `bronSpecifiek.werkvorm` (bv. `"Hybride"`) geëxtraheerd uit het gelabelde "Op locatie of vanuit huis:" paragraaf, zelfde mechanisme als `duur`.

## Known-hash short-circuit (RJC-357 / RJC-401)

`listingHashCoversDetail: false` — de listing-hash (`external_reference`, `id`, `salary_package`, `title`, `updated_at`) ziet de detailpagina niet, en juist daar leeft het facts-blok met o.a. de sluitings-/deadline-informatie (RJC-401: een deadline-only wijziging zou bij een skip een verouderde `sluitingsdatum` bevriezen). Geen `knownHashes`-store doorgegeven (afgedwongen in `sources.spec.ts`).

## Durable cohort (CTP-640, bewezen 2026-09-25)

Harvey Nash is bewezen op het duurzame ingestpad (`curated.durable_job` +
`POLLER_DURABLE_BRONNEN`) als onderdeel van de L3d mixed-adapter-cohort
(Harvey Nash + Hays + Need Staffing IT + Onefellow). De connector en
source-definitie zijn ongewijzigd — de migratie is een bewijslast, geen
codewijziging.

**Live-probe 2026-09-25:** `GET
https://www.harveynash.nl/_sf/api/v1/jobs/search.json` → 401 (24 B) — het
endpoint vereist de POST-wrapper `{"job_search":{…}}`; `POST` met
`{"jobs_per_page":15,"offset":0}` → 200, ~159 KB JSON met `total_size: 41`
(fixtures bijven de bewijslast; de route zelf is live en ongewijzigd in
vorm).

**Resume-contract** (`packages/connectors/src/harveynash/durable-cohort-l3d.spec.ts`,
7 specs): dit is een van de twee cohortleden mét een echte pagina-cursor —
`{page, pageSize}` op de Bullhorn-search API (`offset = page * pageSize`
tegen `total_size`, cap 50). Een duurzame herval HERVAT op de gecommitte
pagina: pagina's achter de cursor worden nooit herlezen en hun items niet
opnieuw opgehaald — exact-één draait daar op de cursor, niet op de replay
key. Een head-insert op een al-gelezen pagina is onzichtbaar voor de
herval (read-pages blind spot; herstelt op de volgende verse poll), en een
herval rapporteert `complete: false, reason: "resumed"` zodat de
missed-poll-reconcile hem overslaat. `knownHashes` wordt bewust níét
doorgegeven (`listingHashCoversDetail: false`): een listing-hash-skip zou
detail-only wijzigingen (facts/jsonLd op de SSR-pagina) bevriezen.
Cap-overschrijding markeert `truncated`, nooit stilletjes compleet.

**Fixture-corpus (eerlijk):** de committed listing-fixture is de echte
API-opname, getrimd tot 1 `results`-entry (`total_size: 31` blijft de
opgenomen waarde); `452d25a3-ae7d-4ee6-9ceb-3c696332799f` is de enige
detail-backed job (`detail-endpoints-specialist.json`). De integratiespec
servert die echte page-0 response en een lege page 1, zodat de gecommitte
checkpoint een echte cursor `{page:2, pageSize:1}` is. Geen opgenomen
reject-fixture.

**End-to-end op de echte pipeline** (fixture-client, `ji_test_iso_*`-Postgres,
`apps/worker/src/poller/l3d-cohort.integration.spec.ts` — 5 specs per bron,
groen): offer → `runDurableBronJobConsumer` → `runBronIngestPipeline` →
observaties, `source_record`s, curated `aanvraag`-rij en `outbox_event`s;
herhaalde run → `unchanged`; gewijzigde detail-payload (`jsonLd.title`) →
`changed` → nieuwe `aanvraag_versie` + bijgewerkte curated rij; gefaalde
page-1-listing-read → run `failed` (`DISCOVER_FAILED`) mét gecommitte
cursor `{page:1,pageSize:1}` → herval via `reopenFailed` (fence +1) hervat
op pagina 1 zonder page 0 te herlezen; abort mid-item → `failed`
(`RAW_STORE_WRITE_FAILED`, CTP-490) → retake exact-één.

**UI-bewijs (geseedde stack):** wegwerp-DB `ji_ctp640_visual_l3d` (door deze
lane aangemaakt), aanvragen gesaaid via het echte duurzame pad met
Manticore-drain (`SEARCH_PROJECTOR=worker`), API `localhost:3000` + web
`localhost:3001` zonder `NEXT_PUBLIC_USE_FIXTURES`: `/jobs` toont de
Bron-facet met alle vier de bronnen incl. tellen; `?source=harvey-nash`
rendert de 1 rij (`Endpoints specialist`). De opname is ouder dan haar
sluitingsdatum, dus de pipeline zette de rij terecht op `closed`; voor de
capture is de geseedde curated rij op `active` met een toekomstige
sluitingsdatum gezet en opnieuw geprojecteerd — fixtures ongewijzigd,
alleen weergavestaat. Captures: `/tmp/ctp640-visual/` (H.264 MP4 + PNG,
geopend en in frame bevestigd).

**Canary en rollback:** `POLLER_DURABLE_BRONNEN` per bron toevoegen, één
tegelijk, ná de L3a/L3b/L3c-cohorten. Rollback = slug uit de vlag halen;
in-flight jobs lopen leeg, geen dubbele scheduling. `HARVEYNASH_LIVE`
blijft uit — dit bewijs is fixture-only. Operator-canary en release-gate
blijven open.
