# Flinter — ingest-recept (geverifieerd 2026-08-31)

Status: **probe afgerond; connector nog niet gebouwd** — adapter-categorie `html`; 18 opdrachten op één listing. Geen technische blocker; data is weinig gestructureerd en voorwaardenstatus is nog te toetsen.

## Endpoints

| Doel | URL | Opmerking |
|---|---|---|
| Listing | `GET https://www.flinter.nl/opdrachten` | Custom SSR; alle 18 kaarten, geen paginering of JSON-LD. |
| Detail | `GET https://www.flinter.nl/opdrachten/<slug>` | SSR, zonder JSON-LD of key/value-tabel. |
| Sitemap | `GET https://www.flinter.nl/sitemap.xml` | Statische urlset; job-URL's niet bevestigd in het gecontroleerde deel. |

## Veldmapping → canoniek `aanvraag`

| Flinter | Canoniek | Provenance/noot |
|---|---|---|
| kaarttitel | `titel` | SSR-listing. |
| kaart-eindklant | `opdrachtgever_naam` | SSR-listing/headerstrip. |
| kaartplaats | `locatie_plaats` | SSR-listing/headerstrip. |
| kaartduur | `looptijd_tekst` | Grove waarden zoals `1 jr`, `>1 jr`, `6 mnd`. |
| uren in introprose | `uren_per_week` | Gedeeltelijk; niet als apart veld aanwezig. |
| detailtekst | `beschrijving` | Vrije tekst; geen vaste metadata-structuur. |

## Ingest-patroon

- Fetch de enkele SSR-listing en parse titel, plaats, duur, eindklant en detailroute uit elke kaart.
- Fetch details alleen voor beschrijving en eventueel uren in prose.
- Poll op lage frequentie; de bron heeft laag volume en geen paginering of XHR.

## Licentie en voorwaarden

- `robots.txt` heeft een lege `Disallow` en geen crawl-delay.
- Een gebruikslicentie of bruikbare ToS-uitkomst staat niet in de probe. Houd `voorwaarden_status: te_toetsen` vóór activatie.

## Risico's

1. Uren zijn slechts gedeeltelijk uit vrije tekst beschikbaar.
2. Tarief, start en deadline ontbreken.
3. Onder `/opdrachten` kan een perm-achtige vacature met salaris en dienstverband staan.

## Sluitingsdatum (RJC-377)

Bevestigd (opnieuw) tegen een live capture van alle 18 vermelde opdrachten: Flinter publiceert nergens een sluitingsdatum, op geen enkele listing- of detailpagina. `sluitingsdatumPassed` blijft hard `false` — eerlijk, geen parse-gat. `looptijdTekst` (bewaard in `bronSpecifiek`) is een vrije contractduur-tekst, geen deadline. Het verdwijnen van de listing is vandaag het enige sluitingssignaal dat Flinter biedt.

## Known-hash short-circuit (RJC-357 / RJC-401)

`listingHashCoversDetail: false` — de listing-hash (`locatiePlaats`, `looptijdTekst`, `opdrachtgeverNaam`, `slug`, `titel`) ziet de detailpagina niet; daar leven titel/beschrijving/tarief en de permanent-vacancy-detectie. Geen `knownHashes`-store doorgegeven (afgedwongen in `sources.spec.ts`).

## Durable ingest-pad (CTP-639, bewezen 2026-09-21)

Flinter is bewezen op het duurzame ingestpad (`curated.durable_job` +
`POLLER_DURABLE_BRONNEN`) als onderdeel van de L3c mixed-adapter-cohort
(CTM + Flinter + Freelancer.nl + Haert). De connector en source-definitie
zijn ongewijzigd — de migratie is een bewijslast, geen codewijziging.

**Activatie-drempel (CTP-649):** Flinter publiceert ~20 opdrachten en de
connector weigert perm-/malformed items, dus een volledige test-import kan
onder de default van 20 distincte observaties blijven. De seed zet daarom
`minimumTestImportObservations: 10` — het schema-drift-gardrail blijft, alleen
lager afgestemd op de echte catalogusgrootte.

**Live-probe 2026-09-21:** `https://www.flinter.nl/opdrachten` → 200,
~117 KB SSR-listing; live telde de pagina 18 kaarten, de committed fixture
bewaart er 2.

**Resume-contract** (`packages/connectors/src/flinter/durable-cohort-l3c.spec.ts`,
6 specs): discovery is één enkele listing-read — `discover()` geeft het hele
corpus terug met `hasMore: false` en een inert `checkpoint: {}`. Er is géén
pagina-cursor: een duurzame herval leest de listing én élke detailpagina
opnieuw — bewust, want `knownHashes` wordt hier níét doorgegeven
(`listingHashCoversDetail: false`): een listing-hash-skip zou detail-only-
wijzigingen bevriezen. De observatie-replay-sleutel
(`scrapeRunId + bronReferentie + contentHash`) absorbeert al-persisteerde
items — exact-één, geen verlies — en een gewijzigde detailpagina onder een
identieke listing-hash landt alsnog als `changed`. Head-inserts worden door
de herval zelf gezien; delistings tellen via `complete: true` mee in de
missed-poll-reconcile.

**Fixture-corpus (eerlijk):** de committed listing-fixture is de echte
opname met 2 kaarten, beide met een echte detail-fixture.
`vergunningverlener-agrarisch` persisteert; `bedrijfsjurist` is een
opgenomen vaste-dienst-vacature (dienstverband + bruto salaris) en reject
by design — de enige reject in deze cohort, vastgelegd, niet weggescopet.

**End-to-end op de echte pipeline** (fixture-client, `ji_test_iso_*`-Postgres,
`apps/worker/src/poller/l3c-cohort.integration.spec.ts` — 5 specs per bron,
groen): offer → `runDurableBronJobConsumer` → `runBronIngestPipeline` →
observaties, `source_record`s, curated `aanvraag`-rijen en `outbox_event`s;
herhaalde run → alles `unchanged` (elke detailfetch draait opnieuw, de
recorder dedupet op `contentHash`), geen duplicaten of extra versies;
gewijzigde detail-payload → `changed`-observatie → nieuwe `aanvraag_versie`
+ bijgewerkte curated rij; gefaalde listing-read → run `failed`
(`DISCOVER_FAILED`) → herval via `reopenFailed` (fence +1) → volledige
her-enumeratie; abort mid-item → `failed` (`RAW_STORE_WRITE_FAILED` —
persistence-abort is nooit benign, CTP-490) → retake exact-één.

**UI-bewijs (geseedde stack):** wegwerp-DB `ji_ctp639_visual_l3c` (door deze
lane aangemaakt), aanvragen gesaaid via het echte duurzame pad met
Manticore-drain (`SEARCH_PROJECTOR=worker`), API `localhost:3000` + web
`localhost:3002` zonder `NEXT_PUBLIC_USE_FIXTURES` (:3001 was door een
operator-SSH-tunnel bezet): `/jobs?source=flinter&archief=1` rendert de 1
rij (`vergunningverlener-agrarisch`, actief) met Bron-chip `Flinter`;
`bedrijfsjurist` staat er bewust níét bij — de recorded permanent-vacancy
reject. Captures: `/tmp/ctp639-visual/` (H.264 MP4 + PNG, geopend en in
frame bevestigd).

**Canary en rollback:** `POLLER_DURABLE_BRONNEN` per bron toevoegen, één
tegelijk, ná de CTP-630/CTP-637/CTP-638-cohorten. Rollback = slug uit de
vlag halen; in-flight jobs lopen leeg, geen dubbele scheduling (`main.ts`
returnt voor de inline poll). `FLINTER_LIVE` blijft uit — dit bewijs is
fixture-only. Operator-canary en release-gate blijven open.
