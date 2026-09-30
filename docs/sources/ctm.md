# CTM (EU-Supply / Mercell) — ingest-recept (geverifieerd 2026-08-30)

Status: **connector, normalisatie en registratie compleet, activatie staat uit** — genormaliseerd en geregistreerd in `packages/application/src/sources/index.ts` (`SupportedBronSlug` bevat nu `ctm`); adapter-categorie `feed`. De worker-routing (`apps/worker/src/poll-bron-run.ts`) leest generiek uit het `SOURCES`-register, dus die is al bruikbaar zonder aparte wijziging. Nog te doen vóór activatie: voorwaardenstatus door een mens laten bevestigen (zie § Licentie) — `voorwaarden_status: te_toetsen` blijft staan en `CTM_LIVE` blijft onset totdat dat gebeurt.

## Endpoint

| Doel | URL | Opmerking |
|---|---|---|
| Feed | `GET https://eu.eu-supply.com/ctm/rss/Rss.ashx?days=30&b=CTMSOLUTION` | Atom (`xmlns="http://www.w3.org/2005/Atom"`), HTTP 200, ~9 KB, geen auth. `days` is het terugkijkvenster; `b` is de bulletin/bulletin-board-code (`CTMSOLUTION`). |
| Publieke lijst (niet gebruikt) | `/ctm/supplier/publictenders?B=CTMSOLUTION` | Alternatieve HTML-lijst, buiten scope voor deze connector. |
| Detail/documenten | Achter gratis account | **Buiten scope.** De feed-entry is de volledige observatie; geen tweede fetch. |

Geverifieerd via `curl` op 2026-08-30: status 200, 5 `<entry>`-elementen in het venster.

## Feed-structuur

Elke `<entry>` bevat standaard Atom-velden (`id`, `title`, `published`, `author>name`, `link`) plus een `<content type="text/xml">` met een genest `<publication xmlns="http://www.eu-supply.com/Rss/Publications">`-blok:

| CTM-veld | Canoniek | Noot |
|---|---|---|
| `entry.id` (bevat `PID=<nummer>`) | `bron_referentie` (aanvraagnummer) | PID geëxtraheerd via regex; valt terug op de volledige atom-`id` als geen PID-patroon matcht |
| `entry.id` (volledige URL) | `bron_specifiek.referentie` | Bewaard als losstaand veld naast het geëxtraheerde nummer |
| `entry.title` | `titel` | |
| `entry.published` | `publicatiedatum` | |
| `publication.etq` | `sluitingstijd` | "estimated time quote"/sluitingstijd, CET |
| `publication.authority[@name]` | `organisatie` | Inkopende organisatie (publiek, geen persoonsgegevens) |
| `publication.processTemplate` | `bron_specifiek.procedure` | bv. "02 - Openbare procedure" |
| `publication.cpvCodes.cpvCode[]` | `bron_specifiek.cpv[]` + `vakgebied_bron` | `{code, name}` per CPV |
| `publication.contactPerson`, `publication.authority[@address*]`, `publication.detailedDescription`, `publication.extendedDescription` | **niet overgenomen** | DEC-008-minimalisatie: alleen de velden die de TenderNed/Inhuurdesk-siblings ook bewaren; contactpersoon-velden zijn in de live feed doorgaans leeg maar worden hoe dan ook nooit doorgezet |

## Ingest-patroon

- **Geen paginering.** De feed retourneert steeds het volledige `days`-venster in één response; er is geen `page`-parameter. `discover()` geeft daarom altijd `hasMore: false`. De known-hash-check in `fetch()` is een optimalisatie (early exit tegen de laatst geziene listing-hash, zelfde patroon als de sibling-connectors); de daadwerkelijke wijzigingsdetectie — wat voorkomt dat ongewijzigde entries opnieuw als nieuw record binnenkomen — loopt via de new/changed/unchanged-vergelijking van de observation recorder verderop in de pipeline.
- Poll **maximaal elke 30 minuten** (venster van `days=30` compenseert gemiste polls ruimschoots; vaker pollen levert geen nieuwe data op).
- Raw-pad volgt het gedeelde `raw/{bronSlug}/...`-schema uit `object-store.ts`; opgeslagen payload is een geminimaliseerd JSON-record per entry (`{ entry }`), niet de ruwe Atom-bytes — zelfde patroon als Inhuurdesk.
- Hash van het geminimaliseerde listing-record voor wijzigingsdetectie (`hashCtmListingItem`).

## Licentie en voorwaarden

- **Status: `voorwaarden_status: te_toetsen` (onbevestigd/onverifieerbaar).** De T&C-pagina van eu-supply.com loopt in een redirect-loop, dus de daadwerkelijke gebruiksvoorwaarden konden niet worden geverifieerd.
- `robots.txt` blokkeert de feed-URL niet.
- Activeer deze bron pas nadat een mens de voorwaardenstatus expliciet op `toegestaan` heeft gezet.

## Overlap met TenderNed (uit SOURCE_MATRIX)

Cross-check 2026-08-27 in `docs/SOURCE_MATRIX.md`: 5/5 boven-drempel Mercell/CTM-aankondigingen (AAO/VAK) stonden dezelfde dag ook op TenderNed. CTM/Mercell voegt dus vooral waarde toe voor:

1. **DAS-minicompetities** binnen een raamovereenkomst — deze worden nooit apart op TenderNed gepubliceerd.
2. **Onderdrempelige rondes** die de EU-publicatieplicht niet halen.

Boven-drempel aanbestedingen die al via TenderNed binnenkomen, zullen dus als duplicaat-achtige content verschijnen (andere bron, zelfde onderliggende aanbesteding) — normalisatie/deduplicatie op titel+organisatie+CPV kan dit later adresseren; buiten scope voor deze connector.

## Risico's

1. Geen paginering/cursor → volledige window-overlap bij elke poll is verwacht gedrag, geen bug.
2. T&C onverifieerbaar (redirect-loop) → voorwaardenstatus blijft `te_toetsen` tot een mens dit oplost.
3. Detail/documenten (geraamde waarde, volledige bijlagenlijst) zijn niet beschikbaar zonder account — deze connector observeert alleen wat in de feed staat.

## Known-hash short-circuit (RJC-357 / RJC-401)

`listingHashCoversDetail: true` — de fetch her-serialiseert de feed-entry zonder tweede request, dus de listing-hash ziet alles wat de normaliser leest. Veld-voor-veld (`hashCtmListingItem` vs `normalise/ctm.ts`):

| `CtmEntry`-veld | In listing-hash | Normaliser leest |
|---|---|---|
| `aanvraagnummer` | ja | `bronReferentie`, `bronSpecifiek` |
| `cpv` | ja | `beschrijving`, `bronSpecifiek` |
| `link` | ja (toegevoegd RJC-357) | `bronUrl` |
| `organisatie` | ja | `beschrijving`, `opdrachtgeverNaam` |
| `procedure` | ja | `beschrijving`, `bronSpecifiek` |
| `publicatiedatum` | ja | `bronSpecifiek` |
| `referentie` | ja | `bronSpecifiek` |
| `sluitingstijd` | ja | `sluitingsdatum`, lifecycle |
| `titel` | ja | `titel`, `beschrijving`-fallback |

Houd `hashCtmListingItem` in sync met `CtmEntry`: een nieuw veld dat niet gehasht wordt maakt de skip onveilig (zie `packages/connectors/src/ctm/ctm.spec.ts`, coverage-test).

## Durable ingest-pad (CTP-639, bewezen 2026-09-21)

CTM is bewezen op het duurzame ingestpad (`curated.durable_job` +
`POLLER_DURABLE_BRONNEN`) als onderdeel van de L3c mixed-adapter-cohort
(CTM + Flinter + Freelancer.nl + Haert). De connector en source-definitie
zijn ongewijzigd — de migratie is een bewijslast, geen codewijziging.

**Live-probe 2026-09-21:**
`https://eu.eu-supply.com/ctm/rss/Rss.ashx?days=30&b=CTMSOLUTION` → 200,
~8,7 KB Atom-feed; het `days=30`-venster bevatte 5 `<entry>`-elementen.

**Activatie-drempel (CTP-649):** de 30-daagse Atom-feed droeg 6 entries op
2026-09-03 — de default van 20 distincte observaties is onhaalbaar klein voor
deze bron. De seed zet daarom `minimumTestImportObservations: 3`; tenders
boven de CTM-drempel verschijnen ook op TenderNed, dus de dekking hangt niet
op deze bron alleen.

**Resume-contract** (`packages/connectors/src/ctm/durable-cohort-l3c.spec.ts`,
8 specs): discovery is één volledige feed-window-read — `discover()` geeft
alle entries terug met `hasMore: false` en een gevuld-maar-inert
`{cursor: <feed updatedAt>}`-checkpoint. Er is géén pagina-cursor en géén
detailrequest: `fetch()` her-serialiseert de feed-entry, die het volledige
wijzigingsvector ís. Daarom geldt `listingHashCoversDetail: true` en geeft de
productie-wiring de `knownHashes`-store wél door: een herhaalde poll op
ongewijzigde entries schrijft NUL observaties (de skip zit vóór de recorder,
niet erin), terwijl een gewijzigde entry-hash de skip passeert en als
`changed` landt. Een duurzame herval op hetzelfde `scrapeRunId` leest het
hele venster opnieuw; head-inserts in het venster worden door de herval zelf
gezien en delistings tellen via `complete: true` mee in de
missed-poll-reconcile.

**Fixture-corpus (eerlijk):** de committed listing-fixture is de echte
feed-opname met 5 entries (`459469`, `459876`, `459877`, `460057`,
`460060`). Elke gepersisteerde payload is een echte opname; detail-fixtures
bestaan niet omdat er géén detailfetch bestaat.

**End-to-end op de echte pipeline** (fixture-client, `ji_test_iso_*`-Postgres,
`apps/worker/src/poller/l3c-cohort.integration.spec.ts` — 5 specs per bron,
groen): offer → `runDurableBronJobConsumer` → `runBronIngestPipeline` →
observaties, `source_record`s, curated `aanvraag`-rijen en `outbox_event`s;
herhaalde run → nul observaties via de known-hash-skip (run slaagt,
missed-poll-reconcile telt niets); gewijzigde feed-entry →
`changed`-observatie → nieuwe `aanvraag_versie` + bijgewerkte curated rij;
gefaalde feed-read → run `failed` (`DISCOVER_FAILED`) → herval via
`reopenFailed` (fence +1) → volledige venster-herlezing; abort mid-item →
`failed` (`RAW_STORE_WRITE_FAILED` — persistence-abort is nooit benign,
CTP-490) → retake exact-één via de observatie-replay-sleutel
(`scrapeRunId + bronReferentie + contentHash`).

**UI-bewijs (geseedde stack):** wegwerp-DB `ji_ctp639_visual_l3c` (door deze
lane aangemaakt), aanvragen gesaaid via het echte duurzame pad met
Manticore-drain (`SEARCH_PROJECTOR=worker`), API `localhost:3000` + web
`localhost:3002` zonder `NEXT_PUBLIC_USE_FIXTURES` (:3001 was door een
operator-SSH-tunnel bezet). `/jobs` toont in actieve scope `8 opdrachten ·
3 in archief`; `/jobs?source=ctm&archief=1` rendert alle 5 rijen met
Bron-chip `CTM` — één seed (`459469`) staat bewust op `GESLOTEN`/archief
door de échte opgenomen sluitingstijd. Captures: `/tmp/ctp639-visual/`
(H.264 MP4 + PNG, geopend en in frame bevestigd).

**Canary en rollback:** `POLLER_DURABLE_BRONNEN` per bron toevoegen, één
tegelijk, ná de CTP-630/CTP-637/CTP-638-cohorten. Rollback = slug uit de
vlag halen; in-flight jobs lopen leeg, geen dubbele scheduling (`main.ts`
returnt voor de inline poll). `CTM_LIVE` blijft uit — dit bewijs is
fixture-only. Operator-canary en release-gate blijven open.
