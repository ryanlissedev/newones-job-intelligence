# Pro-Act IT — ingest-recept (geverifieerd 2026-08-31)

Status: **connector gebouwd** (`packages/connectors/src/json-ld/configs/pro-act.ts`) — adapter-categorie `json-ld`; 17 detaillinks op de listing en 20 locaties in de vacancy-sitemap. Geen technische blocker; voorwaardenstatus nog te toetsen.

## Endpoints

| Doel | URL | Opmerking |
|---|---|---|
| Listing | `GET https://pro-act.nl/vacatures/` | WordPress SSR, geen paginering. |
| Sitemap | `GET https://pro-act.nl/vacancy-sitemap.xml` | 20 locaties, inclusief evergreen- en interne rollen. `www.pro-act.nl` 301-redirect naar de www-loze canonieke host (live 2026-09-21); de connector-config gebruikt die canonieke URL. |
| Detail | `GET https://pro-act.nl/vacatures/<slug>-<id>/` | SSR met JobPosting JSON-LD en gelabeld detailblok. |

## Veldmapping → canoniek `aanvraag`

| Pro-Act IT | Canoniek | Provenance/noot |
|---|---|---|
| `title` | `titel` | JobPosting-detail. |
| `description` | `beschrijving` | JobPosting; bevat ook gelabelde velden. |
| eindklant in beschrijving | `opdrachtgever_naam` | Prose; `hiringOrganization` is de broker. Regex-template `eindklant,? (de\|het )?<Naam>,` bevestigd op 2/2 live captures (25-08-2026). Restrisico (geaccepteerd, advisor review): een plaatsnaam direct na "eindklant," (bv. "eindklant, Den Haag,") zou ook matchen -- geen bekend geval, en elke match is `labelBlock.eindklant`-provenance-getagd, dus auditbaar i.p.v. stil fout. |
| label `Locatie` | `locatie_omschrijving` | Detailblok; JobPosting bevat in de sample alleen het land. |
| label `Inzet` | `uren_per_week` | Detailblok. |
| labels `Start`, `Eind` | `startdatum`, `einddatum` | Detailblok. |
| `validThrough` / label `Verloopt` | `sluitingsdatum` | JobPosting en detailblok. |
| label `Tarief` | `tarief_tekst` | Gedeeltelijk; sample noemt `marktconform`, niet numeriek. |

## Ingest-patroon

- Lees `vacancy-sitemap.xml`, filter evergreen/interne rollen en parse JobPosting per opdracht.
- Parse Start, Eind, Inzet, Tarief en Locatie uit het gelabelde beschrijvingsblok.
- Respecteer `Crawl-delay: 10`; een volledige pass over 20 URL's duurt ongeveer 3,5 minuut.

## Licentie en voorwaarden

- `robots.txt` (live capture 2026-09-21, `/tmp/w9-jsonld-evidence/`): `https://pro-act.nl/robots.txt` → 200; de `User-agent: *`-groep is leeg en `Crawl-delay: 10` + `Disallow: /wp-admin/` staan in de `User-agent: Googlebot`-groep, met een sitemapverwijzing naar `sitemap_index.xml`. De geadministreerde `crawlDelayMs: 10_000` blijft daarom de conservative keuze. `https://www.pro-act.nl/robots.txt` → 404 — de www-host dient alleen als redirect naar de canonieke www-loze host.
- Een gebruikslicentie of bruikbare ToS-uitkomst staat niet in de probe. Houd `voorwaarden_status: te_toetsen` vóór activatie.

## Voorwaarden

- robots.txt: pro-act.nl: HTTP 200, geen Disallow op connectorpaden (/, /vacatures/iso-8783/, /vacatures/senior-azure-operations-engineer-8793/), Crawl-delay 10, geprobed 2026-09-25
- ToS/gebruiksvoorwaarden: zie "Licentie en voorwaarden" hierboven
- Besluit: `toegestaan`
- Besluitnemer en datum: Ryan (operatorbesluit 2026-09-03, live testimport productie)

## Risico's

1. `employmentType=FULL_TIME` is onbetrouwbaar voor interim-opdrachten.
2. `jobLocation` is te grof; parse het zichtbare Locatie-label.
3. Tarief kan niet-numeriek zijn.

## Sluitingsdatum (RJC-377)

Pro-Act IT heeft geen `sluitingsDatum` in zijn label-blok, maar publiceert wel een echte `jobPosting.validThrough` als bare ISO-datum (bv. "2026-09-01"/"2026-10-01" in beide live captures — geen vaste placeholder). Vóór RJC-377 werd dit veld wel opgeslagen in `bronSpecifiek.valid_through` maar nooit gebruikt om te sluiten. De gedeelde json-ld-normaliser gebruikt dit nu als fallback wanneer het label-blok geen `sluitingsDatum` heeft.

## Known-hash short-circuit (RJC-357 / RJC-401)

`listingHashCoversDetail: false` — de listing-hash (`hashJsonLdListingItem`) ziet alleen `url` + `lastmod` uit de sitemap, terwijl de complete JobPosting (incl. sluitings-/deadline-velden, RJC-401) op de detailpagina leeft. Een deadline-only wijziging zonder betrouwbare `lastmod`-bump zou bij een skip een verouderde `sluitingsdatum` bevriezen; `lastmod` is niet bewezen betrouwbaar genoeg om daarop te vertrouwen. Geen `knownHashes`-store doorgegeven (afgedwongen in `sources.spec.ts`).

## Durable JSON-LD-cohort (CTP-630, bewezen 2026-09-21)

Pro-Act IT is bewezen op het duurzame ingestpad (`curated.durable_job` + `POLLER_DURABLE_BRONNEN`). De migratie is een bewijslast — de enige codewijziging is de canonieke www-loze sitemap-URL in de config (live capture wint van de doc; fixture-pad en detail-URL's ongewijzigd).

**Live-probe 2026-09-21** (`/tmp/w9-jsonld-evidence/`): `https://www.pro-act.nl/vacancy-sitemap.xml` → 301 → `https://pro-act.nl/vacancy-sitemap.xml` → 200, ~3 KB urlset met www-loze detail-URL's; `https://pro-act.nl/robots.txt` → 200 (zie Licentie en voorwaarden); `https://www.pro-act.nl/robots.txt` → 404.

**Resume-contract** (`packages/connectors/src/json-ld/durable-cohort.spec.ts`, 6 specs per bron): discovery is één enkele sitemap-pass — `discover()` geeft het hele corpus terug met `hasMore: false` en een inerte `checkpoint: {}`. Er is dus géén pagina-cursor zoals bij de feed-cohort (CTP-629): een duurzame herval op hetzelfde `scrapeRunId` leest de sitemap én elke detailpagina opnieuw, en de observatie-replay-sleutel (`scrapeRunId + bronReferentie + contentHash`) absorbeert al-persisteerde items — exact-één, geen verlies. Een head-insert tussen attempts wordt al door de herval zelf gezien (er is geen "al gelezen pagina's"-blind spot). Een delisting valt gewoon uit de enumeratie; omdat zo'n herval een volledige enumeratie is (`complete: true`), telt de missed-poll-reconcile de verdwenen record meteen mee. **Resterende kloof (eerlijk):** alleen een kill in het smalle venster tussen de checkpoint-write (`{}`) en `complete()` laat een `running`-rij mét checkpoint achter; die herval rapporteert `completeness: "resumed"` — de reconcile wordt dan voor die run overgeslagen hoewel alles opnieuw gelezen is, en een in dat venster verdwenen record wacht op de volgende verse poll voor `missed_polls`. Zelfherstellend, nooit stil verouderd.

**Completeness/`truncated`:** geen paginalimiet en geen cursor; `truncated` blijft altijd afwezig — de enige eerlijke waarde onder het RJC-397-contract.

**End-to-end op de echte pipeline** (fixture-client, `ji_test_iso_*`-Postgres): offer → `runDurableBronJobConsumer` → `runBronIngestPipeline` → observaties, `source_record`s en curated `aanvraag`-rijen; gefaalde listing-read → run `failed` (`DISCOVER_FAILED`, geobserveerd aan het begin van de retake) → herval op hetzelfde `scrapeRunId` (`reopenFailed`, fence +1) → volledige her-enumeratie; abort mid-item → run `failed` (`RAW_STORE_WRITE_FAILED` — een persistence-abort is nooit "benign", CTP-490) → retake her-leest het hele corpus en de replay-dedupe houdt het exact-één. Bewijs: `apps/worker/src/poller/json-ld-cohort.integration.spec.ts` (9 specs, groen).

**Canary en rollback:** eerst `POLLER_DURABLE_BRONNEN=bluetrail`, dan `hero`, dan `pro-act` — één bron tegelijk toevoegen. Rollback = slug uit de vlag halen; in-flight jobs lopen leeg, er ontstaat geen dubbele scheduling (`main.ts` returnt voor de inline poll). Geen dataverlies geclaimd buiten het bovenstaande bewijs.
