# BlueTrail — ingest-recept (geverifieerd 2026-08-31)

Status: **connector gebouwd** (`packages/connectors/src/json-ld/configs/bluetrail.ts`) — adapter-categorie `json-ld`; 144 opdrachten in de geprobeerde listing. Geen technische blocker; voorwaardenstatus nog te toetsen.

## Endpoints

| Doel | URL | Opmerking |
|---|---|---|
| Listing | `GET https://www.bluetrail.nl/opdrachten/` | SSR, 14 detaillinks per pagina; header noemt 144 opdrachten. |
| Sitemap | `GET https://www.bluetrail.nl/job-sitemap.xml` | 145 locaties: 144 jobs plus de listing. |
| Detail | `GET https://www.bluetrail.nl/opdrachten/Interim/<slug>/` | SSR met JobPosting JSON-LD en een label/waarde-tabel. |

## Veldmapping → canoniek `aanvraag`

| BlueTrail | Canoniek | Provenance/noot |
|---|---|---|
| `identifier` | `bron_referentie` | JobPosting-detail. |
| `title` | `titel` | JobPosting-detail. |
| `description` | `beschrijving` | JobPosting-detail. |
| `hiringOrganization.name` | `opdrachtgever_naam` | JobPosting-detail; bij broker-gefronte opdrachten is dit de bemiddelaar, zie Eindklant (F02). |
| opening "Voor [de\|het] <Naam> zoeken wij" in `description` | `opdrachtgever_naam` + `bron_specifiek.eindklant_naam` | Wint van `hiringOrganization` als die zin er staat; zie Eindklant (F02). |
| `jobLocation.address.addressLocality` | `locatie_plaats` | JobPosting-detail. |
| label `Uren per week` | `uren_per_week` | Zichtbare detailtabel. |
| labels `Startdatum`, `Einddatum` | `startdatum`, `einddatum` | Zichtbare detailtabel. |
| label `Sluitingsdatum` | `sluitingsdatum` | Zichtbare detailtabel. |
| `jobLocation.address.addressRegion` | `provincie` | JobPosting-detail; canonieke provincienaam, zichtbaar bevestigd (o.a. "Gelderland", "Zuid-Holland" in live captures). |
| lijst "Wat wordt er van jou gevraagd? › Competenties:" | `skills` | Alleen deze lijst is tag-achtig gestructureerd (bevestigd in live capture 2026-09-16, `detail-adviseur-privacy-ibd.json`). "Eisen"/"Wensen" op dezelfde pagina zijn volledige zinnen, niet gemapt (zou vrije-tekstmining zijn). |
| `baseSalary` | **niet overnemen** | Constante opvulwaarde `100`, ongeacht `unitText` (live 2026-09-16, 129 opdrachten: `""` 45, `UUR` 52, `HOUR` 32). Tarief ontbreekt zichtbaar. |

Opleidingsniveau (F14) is in de live capture van 2026-09-15 nergens als waarde
gerenderd — alleen een CSS-selector (`.job_Opleidingsniveau__c`) voor een
gerelateerde-vacatures-widget die op deze pagina geen data toont. `ABSENT_SRC`
op deze steekproef; niet gemapt.

## Ingest-patroon

- Lees `job-sitemap.xml`, fetch de detail-URL's en parse JobPosting plus de label/waarde-tabel.
- Respecteer `Crawl-delay: 5`; haal geen sorteer- of filter-URL's op.
- Gebruik sitemap/detail als source-of-truth; de listing is alleen een volume- en discovery-controle.

## Licentie en voorwaarden

- `robots.txt` staat listing en details toe, schrijft `Crawl-delay: 5` voor en sluit `/opdrachten/*or-`, `*?order=` en `*?_sft_` uit.
- Een gebruikslicentie of bruikbare ToS-uitkomst staat niet in de probe. Houd `voorwaarden_status: te_toetsen` vóór activatie.

## Voorwaarden

- robots.txt: www.bluetrail.nl: HTTP 200, geen Disallow op connectorpaden (/, /opdrachten/Interim/adviseur-privacy-ibd/, /opdrachten/Interim/adviseur-security-privacy/, /opdrachten/Interim/architect-ict-en-informatielandschap/, /opdrachten/Interim/ciam-tester/, /opdrachten/Interim/ontwikkelmanager/, /opdrachten/Interim/systeembeheerder/, /opdrachten/Interim/teamlead-procesbeschrijver-sr/), Crawl-delay 5, geprobed 2026-09-25
- ToS/gebruiksvoorwaarden: zie "Licentie en voorwaarden" hierboven
- Besluit: `toegestaan`
- Besluitnemer en datum: Ryan (operatorbesluit 2026-09-03, live testimport productie)

## Risico's

1. `baseSalary` is onbetrouwbaar en mag niet als tarief worden genormaliseerd.
2. Eindklant staat alleen in de openingszin; zonder die zin blijft de bemiddelaar `opdrachtgever_naam`.
3. Een volledige detailpass is door de crawl-delay bewust traag.

## Sluitingsdatum (RJC-377)

BlueTrail publiceert een echte sluitingsdatum op twee plekken die elkaar bevestigen: de "In het kort"-sidebar (`Sluitingsdatum`, Nederlandse tekst zoals "2 september 2026") en `jobPosting.validThrough` (RFC 2822-tekst, bv. "Wed, 02 Sep 2026 00:00:00 +0000") — in een live capture (2026-08-31) wijzen beide naar dezelfde dag. Vóór RJC-377 werd het label-blokveld wel opgeslagen in `bronSpecifiek.sluitings_datum` maar nooit gebruikt om te sluiten. De gedeelde json-ld-normaliser gebruikt nu bij voorkeur het label-blokveld (Nederlandse tekst, via `parseDutchDate`), met `validThrough` als fallback voor bronnen zonder label-blok (Pro-Act).

**Bij tegenspraak (codex review):** als het label-blok een `sluitingsDatum` bevat én die wijkt af van `jobPosting.validThrough`, wint het label-blokveld stilzwijgend — er is vandaag geen waarschuwings-/observations-kanaal op deze normaliser om zo'n afwijking te signaleren (niet toegevoegd in deze pass; zie `docs/research/closing-dates-per-source-2026-09-01.md`).

## Known-hash short-circuit (RJC-357 / RJC-401)

`listingHashCoversDetail: false` — de listing-hash (`hashJsonLdListingItem`) ziet alleen `url` + `lastmod` uit de sitemap, terwijl de complete JobPosting (incl. sluitings-/deadline-velden, RJC-401) op de detailpagina leeft. Een deadline-only wijziging zonder betrouwbare `lastmod`-bump zou bij een skip een verouderde `sluitingsdatum` bevriezen; `lastmod` is niet bewezen betrouwbaar genoeg om daarop te vertrouwen. Geen `knownHashes`-store doorgegeven (afgedwongen in `sources.spec.ts`).

## Eindklant vs bemiddelaar (F02, CTP-516)

Live meting 2026-09-16 over alle 129 opdrachten in `job-sitemap.xml`:

- `hiringOrganization` is bij broker-gefronte opdrachten de bemiddelaar: Circle8 (13), SynProfs B.V. (9), Harvey Nash (5), Magnit (5), Aeves (5), BlueMesa (2). Er is geen gestructureerd eindklantveld.
- De eindklant staat alleen in de openingszin "Voor [de|het] <Naam> zoeken wij". Het patroon (hoofdletter verplicht, geen `i`-vlag) matcht 8 van de 129 opdrachten, alle 8 broker-gefront en alle 8 een echte klantnaam (Belastingdienst, Ministerie van Defensie, UWV, Gemeente Stichtse Vecht, Logius - KOOP, CBG). Het matcht nul opdrachten die de klant zelf publiceert.
- Zonder die zin (bv. Harvey Nash "De Operatie van de Politie ...", Circle8 "De eenheid is op zoek naar ...") blijft de bemiddelaar staan. De eindklant uit vrije prosa raden is `GAP_ENRICH` (CTP-482), geen mapping.
- Fixture: `detail-architect-ict-en-informatielandschap-2026-09-16` (Circle8 → Gemeente Stichtse Vecht).

Bestaande rijen:

- `opdrachtgever_naam` herstelt bij de eerstvolgende poll. De eindklant wordt in de connector uit de beschrijving gehaald, en `parserVersion` `bluetrail/v3` verandert de hash van elke rij, zodat curate de nieuwe draftwaarde overneemt. Opdrachten die al uit de sitemap verdwenen zijn houden de bemiddelaar. `renormalise-from-raw` helpt hier niet: de opgeslagen raw bevat de eindklant nog niet. Bekende beperking: curate behoudt de bestaande `dedup_groep_id`, dus zo'n rij blijft gegroepeerd onder de bemiddelaar; cross-source dedup met dezelfde opdracht elders pakt alleen nieuwe rijen.
- Het opvultarief herstelt niet vanzelf, want een onbekende draftwaarde overschrijft niets. `bun run backfill:renormalise-from-raw --bron bluetrail` wist alleen BlueTrail-rijen met exact min = max = 100, eenheid uur, zonder tarief-verrijking in `curated.aanvraag_enrichment`, én een draft zonder tarief (CTP-603). De kopie in `bron_specifiek` gaat mee.

## Durable JSON-LD-cohort (CTP-630, bewezen 2026-09-21)

BlueTrail is bewezen op het duurzame ingestpad (`curated.durable_job` + `POLLER_DURABLE_BRONNEN`). De connector zelf is ongewijzigd — de migratie is een bewijslast, geen codewijziging.

**Live-probe 2026-09-21** (`/tmp/w9-jsonld-evidence/`): `https://www.bluetrail.nl/job-sitemap.xml` → 200, ~19,7 KB urlset; `robots.txt` → 200 met `Crawl-delay: 5`, de `Disallow`-regels voor `/opdrachten/*or-`, `*?order=` en `*?_sft_`, en een sitemapverwijzing naar `sitemap.xml` — ongewijzigd t.o.v. de oorspronkelijke probe.

**Resume-contract** (`packages/connectors/src/json-ld/durable-cohort.spec.ts`, 6 specs per bron): discovery is één enkele sitemap-pass — `discover()` geeft het hele corpus terug met `hasMore: false` en een inerte `checkpoint: {}`. Er is dus géén pagina-cursor zoals bij de feed-cohort (CTP-629): een duurzame herval op hetzelfde `scrapeRunId` leest de sitemap én elke detailpagina opnieuw, en de observatie-replay-sleutel (`scrapeRunId + bronReferentie + contentHash`) absorbeert al-persisteerde items — exact-één, geen verlies. Een head-insert tussen attempts wordt al door de herval zelf gezien (er is geen "al gelezen pagina's"-blind spot). Een delisting valt gewoon uit de enumeratie; omdat zo'n herval een volledige enumeratie is (`complete: true`), telt de missed-poll-reconcile de verdwenen record meteen mee. **Resterende kloof (eerlijk):** alleen een kill in het smalle venster tussen de checkpoint-write (`{}`) en `complete()` laat een `running`-rij mét checkpoint achter; die herval rapporteert `completeness: "resumed"` — de reconcile wordt dan voor die run overgeslagen hoewel alles opnieuw gelezen is, en een in dat venster verdwenen record wacht op de volgende verse poll voor `missed_polls`. Zelfherstellend, nooit stil verouderd.

**Completeness/`truncated`:** geen paginalimiet en geen cursor; `truncated` blijft altijd afwezig — de enige eerlijke waarde onder het RJC-397-contract.

**End-to-end op de echte pipeline** (fixture-client, `ji_test_iso_*`-Postgres): offer → `runDurableBronJobConsumer` → `runBronIngestPipeline` → observaties, `source_record`s en curated `aanvraag`-rijen; gefaalde listing-read → run `failed` (`DISCOVER_FAILED`, geobserveerd aan het begin van de retake) → herval op hetzelfde `scrapeRunId` (`reopenFailed`, fence +1) → volledige her-enumeratie; abort mid-item → run `failed` (`RAW_STORE_WRITE_FAILED` — een persistence-abort is nooit "benign", CTP-490) → retake her-leest het hele corpus en de replay-dedupe houdt het exact-één. Bewijs: `apps/worker/src/poller/json-ld-cohort.integration.spec.ts` (9 specs, groen).

**Canary en rollback:** eerst `POLLER_DURABLE_BRONNEN=bluetrail` (één bron tegelijk); daarna per bron toevoegen (`,hero`, `,pro-act`). Bekijk `curated.durable_job` + `scrape_run`/`bron_health`. Rollback = slug uit de vlag halen; in-flight jobs lopen leeg, er ontstaat geen dubbele scheduling (`main.ts` returnt voor de inline poll). Geen dataverlies geclaimd buiten het bovenstaande bewijs.
