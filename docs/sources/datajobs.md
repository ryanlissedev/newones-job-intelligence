# DataJobs.nl — ingest-recept

Status: **probe afgerond; connector toegevoegd** — adapter-categorie `json-ld`.
DataJobs gebruikt een enkele Drupal-sitemap voor vacatures en andere pagina's.

## Endpoints

| Doel | URL | Opmerking |
|---|---|---|
| Sitemap | `GET https://www.datajobs.nl/sitemap.xml` | 972 entries; 244 bevestigde één-segment vacature-URL's. |
| Sample detail | `https://www.datajobs.nl/vacatures/aiml-engineer-bij-ilionx` | JobPosting JSON-LD, identifier `datajobs-3606`. |

## Discovery en ATS

De sitemap mengt CMS-, werkgevers-, salarisgids- en facetpagina's met echte
vacatures. De connector houdt alleen exact `/vacatures/<slug>` zonder trailing
slash: twee-segment facetpaden en alle andere paden vallen weg.

## Veldmapping → canoniek `aanvraag`

| JobPosting JSON-LD | Canoniek | Provenance/noot |
|---|---|---|
| `title` | `titel` | `AI/ML Engineer`, `Data Engineer`, `Privacy officer`. |
| `description` | `beschrijving` | Gepubliceerde JobPosting-beschrijving. |
| Detail-URL | `bron_referentie` / `bronUrl` | Connector-URL. |
| `identifier.value` | `bronSpecifiek.identifier.value` | `datajobs-3606`, `datajobs-3609`, `datajobs-3612`. |
| `datePosted` | `bronSpecifiek.publicatiedatum` | Exacte gepubliceerde timestamps uit JSON-LD. |
| `employmentType` | `bronSpecifiek.contract_type` | `FULL_TIME`. |
| `baseSalary` | `tarief` | Ilionx EUR 4500–6500 per maand; Altena EUR 3426–4908 per maand. Verpact publiceert geen salaris: UNKNOWN. |
| `validThrough` | sluitingsmoment/status | Op alle drie afwezig: UNKNOWN. |
| `hiringOrganization.name` | `opdrachtgeverNaam` | `ilionx`, `Verpact`, `Gemeente Altena` zijn benoemde werkgevers; de gedeelde regel promoveert dit niet naar `eindklant_naam` zonder expliciet `eindklant`-veld, dus dat blijft UNKNOWN. |
| `jobLocation.address.addressLocality` / `addressCountry` | `locatieTekst` / `locatieLand` | Groningen/NL, Den Haag/NL, Altena/NL. |

## Robots, crawl delay en known hashes

Voor deze host is geen `robots.txt`-crawl-delaydirective gevonden. De seed volgt
de uniforme waarde van 2000 ms. Fixture-captures: listing
`2026-09-16T20:14:56.533Z`, ilionx `2026-09-16T20:15:13.258Z`, Verpact
`2026-09-16T20:15:35.699Z`, Altena `2026-09-16T20:15:44.722Z`.

`listingHashCoversDetail: false`: de sitemapmetadata dekt de detail-JobPosting
niet. Known hashes worden daarom niet doorgegeven.

## Voorwaarden

- robots.txt: www.datajobs.nl: HTTP 200, geen Disallow op connectorpaden (/, /vacatures/), geprobed 2026-09-25
- ToS/gebruiksvoorwaarden: niet gevonden
- Besluit: `te_toetsen`
- Besluitnemer en datum: open voor Robbie (geen besluit vastgelegd)

## Durable JSON-LD-cohort (CTP-638, bewezen 2026-09-21)

DataJobs.nl is bewezen op het duurzame ingestpad (`curated.durable_job` +
`POLLER_DURABLE_BRONNEN`). De connector en source-definitie zijn ongewijzigd —
de migratie is een bewijslast, geen codewijziging.

**Live-probe 2026-09-21:** `https://www.datajobs.nl/sitemap.xml` → 200,
~199 KB urlset met detaillinks.

**Resume-contract** (`packages/connectors/src/json-ld/durable-cohort-l3b.spec.ts`,
6 specs per bron): discovery is één enkele sitemap-pass — `discover()` geeft het
hele corpus terug met `hasMore: false` en een inerte `checkpoint: {}`. Er is
géén pagina-cursor: een duurzame herval op hetzelfde `scrapeRunId` leest de
sitemap én elke detailpagina opnieuw, en de observatie-replay-sleutel
(`scrapeRunId + bronReferentie + contentHash`) absorbeert al-persisteerde items
— exact-één, geen verlies. Een head-insert wordt al door de herval zelf gezien;
een delisting valt uit de enumeratie en telt via `complete: true` meteen mee in
de missed-poll-reconcile. **Resterende kloof (eerlijk):** alleen een kill tussen
de checkpoint-write (`{}`) en `complete()` laat een `running`-rij mét checkpoint
achter; die herval rapporteert `resumed` en slaat de reconcile voor die run over
— een in dat venster verdwenen record wacht op de volgende verse poll.
Zelfherstellend, nooit stil verouderd.

**Fixture-corpus (eerlijk):** de committed listing-fixture is de echte
sitemap-opname (972 `<loc>`-entries; 244 één-segment vacature-URL's na
uitsluiting), waarvan er 3 een detail-fixture hebben (`aiml-engineer-bij-ilionx`,
`data-engineer-bij-verpact`, `privacy-officer-bij-gemeente-altena`). De
integratiespec scope de écht geparse listing daarom op de detail-backed URL's;
elke gepersisteerde payload is een echte opname. Er is géén opgenomen
soft-404/reject-fixture voor deze bron — alle drie de detail-URL's persisteren.
Heel-corpus-enumeratie is los vastgelegd in de connector-spec.

**End-to-end op de echte pipeline** (fixture-client, `ji_test_iso_*`-Postgres,
`apps/worker/src/poller/json-ld-cohort-l3b.integration.spec.ts` — 5 specs per
bron, groen): offer → `runDurableBronJobConsumer` → `runBronIngestPipeline` →
observaties, `source_record`s, curated `aanvraag`-rijen en `outbox_event`s;
herhaalde run → alles `unchanged`, geen duplicaten of extra versies; gewijzigd
detail-payload → `changed`-observatie → nieuwe `aanvraag_versie` + bijgewerkte
curated rij; gefaalde listing-read → run `failed` (`DISCOVER_FAILED`, gezien aan
het begin van de retake) → herval via `reopenFailed` (fence +1) → volledige
her-enumeratie; abort mid-item → `failed` (`RAW_STORE_WRITE_FAILED` —
persistence-abort is nooit benign, CTP-490) → retake exact-één.

**UI-bewijs (geseedde stack):** wegwerp-DB `ji_ctp638_visual_l3b` (door deze
lane aangemaakt én gedropt), aanvragen gesaaid via het echte duurzame pad met
Manticore-drain (`SEARCH_PROJECTOR=worker`), API :3000 + web :3001 zonder
`NEXT_PUBLIC_USE_FIXTURES`: `/jobs` toont in de Bron-facet `DataJobs.nl 3`;
`?source=datajobs-nl` rendert de 3 rijen (de UI leidt de filter-slug af uit de
bron-naam via `bronNameToSource`, dus `DataJobs.nl` → `datajobs-nl`). Captures:
`/tmp/ctp638-visual/` (H.264 MP4 + PNG, geopend en in frame bevestigd).
Archief-toggle niet van toepassing — alle seeds zijn actief.

**Canary en rollback:** `POLLER_DURABLE_BRONNEN` per bron toevoegen, één
tegelijk, ná de CTP-630/CTP-637-cohorten. Rollback = slug uit de vlag halen;
in-flight jobs lopen leeg, geen dubbele scheduling (`main.ts` returnt voor de
inline poll). `DATAJOBS_LIVE` blijft uit — dit bewijs is fixture-only.
Operator-canary en release-gate blijven open.
