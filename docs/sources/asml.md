# ASML

## Inventory

- Listing UI: `https://www.asml.com/en/careers/find-your-job` (Sitecore/Next.js)
- Discovery: `https://www.asml.com/en/job_posting-sitemap.xml`
- Verified sitemap volume: approximately 586 `<loc>` entries on 2026-09-16
- Detail sample: `https://www.asml.com/en/careers/find-your-job/senior-electrical-safety-expert-nominated-person--installatie-verantwoordelijke-euv-factory-j00333473`
- Apply board: `https://asml.wd3.myworkdayjobs.com/ASMLEXT1` (the connector does not crawl this board)

The sitemap is global. The connector keeps canonical careers detail URLs and drops the listing root and non-detail noise. It does not discover jobs through filter/facet query parameters.

## Detail parsing

ASML detail pages do not publish a `JobPosting` JSON-LD block. With the ASML-only `detailSynthesizer` config field, the shared JSON-LD client reads `props.pageProps.jobData` from `__NEXT_DATA__` and synthesises the minimum `JobPosting` node needed by the shared normaliser.

The sample maps as follows:

| ASML `jobData` | JSON-LD / normalised field |
| --- | --- |
| `displayJobTitle` | `JobPosting.title` |
| `datePosted` | `JobPosting.datePosted`, retaining `2026-08-17T00:00:00` |
| `descriptionExternal` | `JobPosting.description` |
| `id` (`J-00333473`) | `identifier.value` and `labelBlock.referentienummer` |
| `city` (`Veldhoven`) | `jobLocation.address.addressLocality` and shared `locatieTekst` |
| `country` (`Netherlands`) | `jobLocation.address.addressCountry` = `NL`; shared normaliser `locatieLand` remains its documented `NL` value |
| `timeType` (`Full time`) | `employmentType` = `FULL_TIME` |
| `detailPageUrl` | `JobPosting.url` |
| `applyUrl` | `labelBlock.workdayApplyUrl` |

The Workday requisition id is `J-00333473`, while the ASML canonical URL slug ends in lowercase `j00333473`; these are related identifiers but are not interchangeable. A Workday apply link is retained as source metadata only.

## Robots and terms

Robots allows the canonical careers pages and provides a sitemap. The following disallowed filter parameters are honoured: `job_country`, `query`, `job_type`, `job_teams`, `job_technical_fields`, `job_degrees`, `job_experience_levels`, `job_educational_backgrounds`, `job_city`, `sort_by`, and `tags`, including their `&` variants. `/en/Presentation` and `/sitecore` paths are also excluded.

The terms of use were a standard IP skim and are not Gate0; `voorwaardenStatus` is therefore `te_toetsen`.

## Voorwaarden

- robots.txt: www.asml.com: HTTP 200, geen Disallow op connectorpaden (/en/, /en/careers/find-your-job/), geprobed 2026-09-25
- ToS/gebruiksvoorwaarden: zie "Robots and terms" hierboven
- Besluit: `te_toetsen`
- Besluitnemer en datum: open voor Robbie (geen besluit vastgelegd)

## Operations

- `bronId`: `00000000-0000-4000-8000-00000000000f`
- Parser version: `asml/v1`
- Live gate: `ASML_LIVE=1`
- Crawl delay: 2000 ms
- Method: `json-ld`
- `listingHashCoversDetail: false`; known hashes are intentionally not forwarded because the sitemap hash cannot cover changes in detail-page `jobData`.

The fixture is a sanitised capture: recruiter/owner fields are redacted and no cookies or tokens are retained.

## Durable JSON-LD-cohort (CTP-637, bewezen 2026-09-21)

ASML is bewezen op het duurzame ingestpad (`curated.durable_job` + `POLLER_DURABLE_BRONNEN`). De connector en source-definitie zijn ongewijzigd — de migratie is een bewijslast, geen codewijziging.

**Live-probe 2026-09-21:** `https://www.asml.com/en/job_posting-sitemap.xml` → 200, ~211 KB urlset met detaillinks.

**Resume-contract** (`packages/connectors/src/json-ld/durable-cohort-l3a.spec.ts`, 6 specs per bron): discovery is één enkele sitemap-pass — `discover()` geeft het hele corpus terug met `hasMore: false` en een inerte `checkpoint: {}`. Er is géén pagina-cursor: een duurzame herval op hetzelfde `scrapeRunId` leest de sitemap én elke detailpagina opnieuw, en de observatie-replay-sleutel (`scrapeRunId + bronReferentie + contentHash`) absorbeert al-persisteerde items — exact-één, geen verlies. Een head-insert wordt al door de herval zelf gezien; een delisting valt uit de enumeratie en telt via `complete: true` meteen mee in de missed-poll-reconcile. **Resterende kloof (eerlijk):** alleen een kill tussen de checkpoint-write (`{}`) en `complete()` laat een `running`-rij mét checkpoint achter; die herval rapporteert `resumed` en slaat de reconcile voor die run over — een in dat venster verdwenen record wacht op de volgende verse poll. Zelfherstellend, nooit stil verouderd.

**Fixture-corpus (eerlijk):** de committed listing-fixture is de echte sitemap-opname (2 vacature-URL's na uitsluiting), waarvan 1 een detail-fixture heeft (`senior-electrical-safety-expert-...-j00333473`). De integratiespec scope de écht geparse listing daarom op de detail-backed URL's; elke gepersisteerde payload is een echte opname. Heel-corpus-enumeratie is los vastgelegd in de connector-spec.

**End-to-end op de echte pipeline** (fixture-client, `ji_test_iso_*`-Postgres, `apps/worker/src/poller/json-ld-cohort-l3a.integration.spec.ts` — 5 specs per bron, groen): offer → `runDurableBronJobConsumer` → `runBronIngestPipeline` → observaties, `source_record`s, curated `aanvraag`-rijen en `outbox_event`s; herhaalde run → alles `unchanged`, geen duplicaten of extra versies; gewijzigd detail-payload → `changed`-observatie → nieuwe `aanvraag_versie` + bijgewerkte curated rij; gefaalde listing-read → run `failed` (`DISCOVER_FAILED`, gezien aan het begin van de retake) → herval via `reopenFailed` (fence +1) → volledige her-enumeratie; abort mid-item → `failed` (`RAW_STORE_WRITE_FAILED` — persistence-abort is nooit benign, CTP-490) → retake exact-één. ASML-specifiek: het fixture-corpus telt één item, dus de abort valt op de eerste detail-read — er is geen pre-abort observatie om te absorberen; de retake schrijft het item vers. De replay-absorptie is voor ASML bewezen in de connector-spec met een gescript corpus.

**UI-bewijs (geseedde stack):** wegwerp-DB `ji_ctp637_visual_l3a` (door deze lane aangemaakt én gedropt), aanvragen gesaaid via het echte duurzame pad met Manticore-drain (`SEARCH_PROJECTOR=worker`), API :3000 + web :3001 zonder `NEXT_PUBLIC_USE_FIXTURES`: `/jobs` toont in de Bron-facet `ASML 1`; `?source=asml` rendert de rij. Captures: `/tmp/ctp637-visual/` (H.264 MP4 + PNG, geopend en in frame bevestigd). Archief-toggle niet van toepassing — alle seeds zijn actief.

**Canary en rollback:** `POLLER_DURABLE_BRONNEN` per bron toevoegen, één tegelijk, ná de CTP-630-cohort. Rollback = slug uit de vlag halen; in-flight jobs lopen leeg, geen dubbele scheduling (`main.ts` returnt voor de inline poll). `ASML_LIVE` blijft uit — dit bewijs is fixture-only. Operator-canary en release-gate blijven open.
