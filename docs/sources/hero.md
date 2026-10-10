# Hero.eu — ingest-recept (geverifieerd 2026-08-31)

Status: **connector gebouwd** (`packages/connectors/src/json-ld/configs/hero.ts`) — adapter-categorie `json-ld` met HTML/sitemap-discovery; 49 actuele interim-opdrachten. Geen technische blocker; velden zijn dun en voorwaardenstatus is nog te toetsen.

## Endpoints

| Doel | URL | Opmerking |
|---|---|---|
| Listing | `GET https://hero.eu/interim-opdrachten` | Next.js RSC SSR; alle 49 detaillinks op één pagina, geen listing-JSON-LD. |
| Sitemap | `GET https://hero.eu/sitemap.xml` | Eén urlset met taalalternatieven. |
| Detail | `GET https://hero.eu/interim-opdrachten/<slug>-<8-hex>` | SSR met JobPosting JSON-LD. |

## Veldmapping → canoniek `aanvraag`

| Hero.eu | Canoniek | Provenance/noot |
|---|---|---|
| `title` | `titel` | JobPosting-detail. |
| `description` | `beschrijving` | Korte teaser op detail. |
| `datePosted` | `gepubliceerd_op` | JobPosting-detail. |
| `jobLocation` | `locatie_plaats`, `locatie_land` | JobPosting-detail en zichtbaar label `Regio`. |
| `workHours` | `uren_per_week` | JobPosting-detail; zichtbaar als `Uren per week`. |
| `hiringOrganization` | `bron_specifiek.broker` | Hero Interim Professionals, niet de geanonimiseerde eindklant. |
| werkvorm | **niet gevonden** | CORRECTIE 2026-09-15 (was: "kaartlabels werkvorm/sector \| Listing"): een live capture (`fixtures/connectors/hero/detail-analist-archivering.json` (heropgenomen 2026-09-16) + de listing-pagina) laat geen werkvorm per vacaturekaart zien. `jobLocation`/werklocatie-waarden ("Hybride (50/50)", "Hybride in overleg", "Op locatie") bestaan alleen als opties van het filter-dropdown op de listing, niet gekoppeld aan een individuele vacature. `jobLocationType` ontbreekt ook in de JobPosting JSON-LD. `ABSENT_SRC`, niet gemapt. |

## Ingest-patroon

- Ontdek detail-URL's via de SSR-listing of sitemap en parse JobPosting per detail.
- Gebruik `/api/` niet: dit pad is in `robots.txt` uitgesloten.
- Poll via publieke HTML/sitemap; fetch alleen detailpagina's die voor discovery nodig zijn.

## Licentie en voorwaarden

- `robots.txt` staat publieke pagina's toe, sluit onder meer `/api/`, `/auth/` en `/onboarding/` uit en staat GPTBot, ChatGPT-User en OAI-SearchBot expliciet toe.
- Een gebruikslicentie of bruikbare ToS-uitkomst staat niet in de probe. Houd `voorwaarden_status: te_toetsen` vóór activatie.

## Voorwaarden

- robots.txt: hero.eu: HTTP 200, geen Disallow op connectorpaden (/, /interim-opdrachten/), geprobed 2026-09-25
- ToS/gebruiksvoorwaarden: zie "Licentie en voorwaarden" hierboven
- Besluit: `toegestaan`
- Besluitnemer en datum: Ryan (operatorbesluit 2026-09-03, live testimport productie)

## Risico's

1. Opdrachtgever is geanonimiseerd.
2. Tarief, start en deadline ontbreken.
3. De listing bevat geen JSON-LD; discovery en detailparsing zijn twee stappen.

## Sluitingsdatum (RJC-377)

Hero.eu publiceert geen enkel sluitingssignaal: geen label-blok (er is geen `labelBlock`-config voor deze bron) en geen `jobPosting.validThrough` (bevestigd afwezig in beide live captures, `fixtures/connectors/hero/detail-{1,2}.json`). `sluitingsdatumPassed` blijft hard `false` via de gedeelde json-ld-normaliser — eerlijk, geen parse-gat. Het verdwijnen van de listing is vandaag het enige sluitingssignaal.

## Known-hash short-circuit (RJC-357 / RJC-401)

`listingHashCoversDetail: false` — de listing-hash (`hashJsonLdListingItem`) ziet alleen `url` + `lastmod` uit de sitemap, terwijl de complete JobPosting (incl. sluitings-/deadline-velden, RJC-401) op de detailpagina leeft. Een deadline-only wijziging zonder betrouwbare `lastmod`-bump zou bij een skip een verouderde `sluitingsdatum` bevriezen; `lastmod` is niet bewezen betrouwbaar genoeg om daarop te vertrouwen. Geen `knownHashes`-store doorgegeven (afgedwongen in `sources.spec.ts`).

## Durable JSON-LD-cohort (CTP-630, bewezen 2026-09-21)

Hero.eu is bewezen op het duurzame ingestpad (`curated.durable_job` + `POLLER_DURABLE_BRONNEN`). De connector zelf is ongewijzigd — de migratie is een bewijslast, geen codewijziging.

**Live-probe 2026-09-21** (`/tmp/w9-jsonld-evidence/`): `https://hero.eu/interim-opdrachten` → 200, ~172 KB HTML met de detaillinks in de SSR-listing; `robots.txt` → 200, staat GPTBot/ClaudeBot c.s. expliciet toe en sluit `/api/` uit — ongewijzigd t.o.v. de oorspronkelijke probe.

**Resume-contract** (`packages/connectors/src/json-ld/durable-cohort.spec.ts`, 6 specs per bron): discovery is één enkele listing-pass (`discovery.kind: "listing"` — de detaillinks worden uit de SSR-HTML gehaald) — `discover()` geeft het hele corpus terug met `hasMore: false` en een inerte `checkpoint: {}`. Er is dus géén pagina-cursor zoals bij de feed-cohort (CTP-629): een duurzame herval op hetzelfde `scrapeRunId` leest de listing én elke detailpagina opnieuw, en de observatie-replay-sleutel (`scrapeRunId + bronReferentie + contentHash`) absorbeert al-persisteerde items — exact-één, geen verlies. Een head-insert tussen attempts wordt al door de herval zelf gezien (er is geen "al gelezen pagina's"-blind spot). Een delisting valt gewoon uit de enumeratie; omdat zo'n herval een volledige enumeratie is (`complete: true`), telt de missed-poll-reconcile de verdwenen record meteen mee. **Resterende kloof (eerlijk):** alleen een kill in het smalle venster tussen de checkpoint-write (`{}`) en `complete()` laat een `running`-rij mét checkpoint achter; die herval rapporteert `completeness: "resumed"` — de reconcile wordt dan voor die run overgeslagen hoewel alles opnieuw gelezen is, en een in dat venster verdwenen record wacht op de volgende verse poll voor `missed_polls`. Zelfherstellend, nooit stil verouderd.

**Completeness/`truncated`:** geen paginalimiet en geen cursor; `truncated` blijft altijd afwezig — de enige eerlijke waarde onder het RJC-397-contract.

**End-to-end op de echte pipeline** (fixture-client, `ji_test_iso_*`-Postgres): offer → `runDurableBronJobConsumer` → `runBronIngestPipeline` → observaties, `source_record`s en curated `aanvraag`-rijen; gefaalde listing-read → run `failed` (`DISCOVER_FAILED`, geobserveerd aan het begin van de retake) → herval op hetzelfde `scrapeRunId` (`reopenFailed`, fence +1) → volledige her-enumeratie; abort mid-item → run `failed` (`RAW_STORE_WRITE_FAILED` — een persistence-abort is nooit "benign", CTP-490) → retake her-leest het hele corpus en de replay-dedupe houdt het exact-één. Bewijs: `apps/worker/src/poller/json-ld-cohort.integration.spec.ts` (9 specs, groen).

**Canary en rollback:** eerst `POLLER_DURABLE_BRONNEN=bluetrail`; voeg `hero` daarna als eigen stap toe — één bron tegelijk. Rollback = slug uit de vlag halen; in-flight jobs lopen leeg, er ontstaat geen dubbele scheduling (`main.ts` returnt voor de inline poll). Geen dataverlies geclaimd buiten het bovenstaande bewijs.
