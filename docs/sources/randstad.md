# Randstad — ingest-recept

Status: **probe afgerond; connector toegevoegd** — adapter-categorie `json-ld`.
Randstad publiceert JobPosting JSON-LD op vacaturepagina's van de eigen
staffingportal.

## Endpoints

| Doel | URL | Opmerking |
|---|---|---|
| Sitemap | `GET https://www.randstad.nl/job-sitemap.xml` | Ongeveer 3118 vacature-URL's; de eerste vijf staan in de fixture. |
| Detail | `https://www.randstad.nl/vacatures/<numeriek-id>/<slug>` | Detailpagina met JobPosting JSON-LD. |
| Sample detail | `https://www.randstad.nl/vacatures/752363/teamleider` | JSON-LD bevat identifier `752363` en een maandloonband. |

## Discovery en veldmapping

Elke sitemap-entry heeft exact de vorm `/vacatures/<numeriek-id>/<slug>`.
Alleen de kale `/vacatures`-root (ook met querystring) wordt defensief
uitgesloten. De sitemap bevat het hele staffingbord: vast, tijdelijk en
interim zijn gemengd en er is geen deterministisch ICT/interim/freelance-
of detacheringfilter op sitemap- of robotsniveau. Dit past bij de wave-2
probe (`randstad-nl-interim`): er is geen aparte Randstad NL interim/zzp-
brand; de algemene staffingportal dekt dienstverband en interim samen.

| Randstad JSON-LD | Canoniek | Provenance/noot |
|---|---|---|
| `title` | `titel` | Letterlijk overgenomen. |
| `description` | `beschrijving` | HTML wordt door de shared normaliser gestript. |
| URL-pad | `bron_referentie` | Het vacaturepad blijft de referentie. |
| `identifier.value` | `bronSpecifiek.identifier.value` | Vacaturenummer. |
| `datePosted` | `bronSpecifiek.publicatiedatum` | Publicatiedatum, niet startdatum. |
| `employmentType` | `bronSpecifiek.contract_type` | Alleen een string wordt door de shared normaliser gecureerd; arrays blijven absent. |
| `hiringOrganization.name` | `opdrachtgeverNaam` | `Randstad`, de broker; eindklant blijft UNKNOWN (CTP-516). |
| `jobLocation.address.addressLocality` | `locatieTekst` | Eerste gepubliceerde locatie. |
| `baseSalary` | `tarief` | EUR-band met `MONTH` of `HOUR`, als gepubliceerd. |
| `validThrough` | sluitingsmoment | Alleen als de bron dit veld publiceert. |

## Robots, crawl-delay en known hashes

De live robots.txt noemt deze sitemap en blokkeert `/vacatures/` niet. Er is
geen sitemap-specifieke crawl-delay vastgelegd; de connector gebruikt daarom
de projectvloer van 2 seconden. `listingHashCoversDetail: false`: de sitemap
kan de JSON-LD-detailvelden niet afdekken, dus detailwijzigingen mogen niet
door known hashes worden overgeslagen.

De fixture → connector → normalise → curate-assertie staat niet in deze
source-test: curatie gebruikt `createBronRuntimeClient` en vereist live
Postgres; daarvoor zouden `apps/worker/src/curation-recovery.spec.ts` en
infra-scope moeten wijzigen, buiten deze lane.



## Durable JSON-LD-cohort (CTP-642, bewezen 2026-09-25)

Randstad is bewezen op het duurzame ingestpad (`curated.durable_job` +
`POLLER_DURABLE_BRONNEN`) als onderdeel van de L3f JSON-LD-cohort (Randstad
+ Techniekwerkt). De connector en source-definitie zijn ongewijzigd — de
migratie is een bewijslast, geen codewijziging.

**Live-probe 2026-09-25:** `https://www.randstad.nl/job-sitemap.xml` → 200,
~562 KB XML (`application/xml`).

**Resume-contract** (`packages/connectors/src/json-ld/durable-cohort-l3f.spec.ts`,
6 specs): `discovery.kind` is `sitemap` — één sitemap levert het hele
corpus; `discover()` geeft alles terug met `hasMore: false` en een inert
`checkpoint: {}`. Er is géén pagina-cursor: een duurzame herval
her-enumereert élke detail-URL en herfetched élke detailpagina; exact-één
draait op de observatie-replay sleutel (`scrapeRunId + bronReferentie +
contentHash`). Head-inserts ziet de herval direct; delistings tellen mee
via `complete: true` in de missed-poll-reconcile. De
`detailSynthesizer` (`synthesizeContactsFromRandstadPage`) vult alleen
`contactpersonen` aan náást de expliciete JobPosting — hij is nooit de
enige bron van de payload.

**Fixture-corpus (eerlijk):** de committed sitemap-fixture is de echte
opname en parset naar 5 vacature-URL's; daarvan zijn er 2 detail-backed
(`741140/vrachtwagenchauffeur-allround`, `749250/operator`). De derde
committed detail-fixture (`752363/teamleider`) staat NIET in de opgenomen
sitemap — de gescopte corpus kan hem niet bereiken, dus die fixture blijft
gedocumenteerd maar wordt niet verzwegen als bewijs. Geen opgenomen
reject-fixture.

**End-to-end op de echte pipeline** (fixture-client, `ji_test_iso_*`-Postgres,
`apps/worker/src/poller/json-ld-cohort-l3f.integration.spec.ts` — 5 specs
per bron, groen): offer → `runDurableBronJobConsumer` →
`runBronIngestPipeline` → observaties, `source_record`s, curated
`aanvraag`-rijen en `outbox_event`s; herhaalde run → `unchanged`;
gewijzigde JobPosting-payload → `changed` → nieuwe `aanvraag_versie` +
bijgewerkte curated rij; gefaalde listing-read → run `failed`
(`DISCOVER_FAILED`) → herval via `reopenFailed` (fence +1) → volledige
her-enumeratie; abort mid-item → `failed` (`RAW_STORE_WRITE_FAILED`,
CTP-490) → retake exact-één.

**UI-bewijs (geseedde stack):** wegwerp-DB `ji_ctp642_visual_l3f` (door
deze lane aangemaakt), aanvragen gesaaid via het echte duurzame pad met
Manticore-drain (`SEARCH_PROJECTOR=worker`), API `localhost:3000` + web
`localhost:3001` zonder `NEXT_PUBLIC_USE_FIXTURES`: `/jobs` toont de
Bron-facet met beide bronnen incl. tellen; `?source=randstad` rendert de
gefilterde lijst. Captures: `/tmp/ctp642-visual/` (H.264 MP4 + PNG,
geopend en in frame bevestigd).

**Canary en rollback:** `POLLER_DURABLE_BRONNEN` per bron toevoegen, één
tegelijk, ná de L3a–L3e-cohorten. Rollback = slug uit de vlag halen;
in-flight jobs lopen leeg, geen dubbele scheduling. `RANDSTAD_LIVE` blijft
uit — dit bewijs is fixture-only. Operator-canary en release-gate blijven
open.

## Voorwaarden

- robots.txt: www.randstad.nl: HTTP 200, geen Disallow op connectorpaden (/, /vacatures/741140/, /vacatures/749250/, /vacatures/752363/), geprobed 2026-09-25
- ToS/gebruiksvoorwaarden: niet gevonden
- Besluit: `te_toetsen`
- Besluitnemer en datum: open voor Robbie (geen besluit vastgelegd)
