# Onefellow — ingest-recept (geverifieerd 2026-08-31)

Status: **probe afgerond; connector nog niet gebouwd** — adapter-categorie `json-api`; 50 opdrachten in één response. Geen technische blocker; privé-API-risico en voorwaardenstatus blijven expliciet.

## Endpoints

| Doel | URL | Opmerking |
|---|---|---|
| Listing | `GET https://onefellow.nl/opdrachten` | React-SPA; 50 opdrachten na hydration. |
| JSON-listing | `GET https://yhjktxqtoyeruztiwupf.supabase.co/functions/v1/olli-jobs?action=list` | Zonder waargenomen API-key/auth; `{jobs:[50]}`. |
| Detail/fallback | `GET https://onefellow.nl/opdrachten/<joborder_id>` | Browser-rendered detail met JobPosting JSON-LD. |

## Privé-API

Besluit Ryan, 2026-08-31: ongedocumenteerde JSON-endpoints MOGEN gebruikt worden, met een expliciete fallback naar SSR/JSON-LD, en elke bron die zo'n endpoint gebruikt moet in zijn doc vermelden dat het een privé, ongedocumenteerd API is dat zonder waarschuwing kan wijzigen.

Voor Onefellow is dit een ongedocumenteerd, privé endpoint; het kan zonder waarschuwing wijzigen. Fallback: render `/opdrachten/<joborder_id>` in een browser en parse de zichtbare velden plus de na hydration aanwezige JobPosting JSON-LD.

## Veldmapping → canoniek `aanvraag`

| Onefellow | Canoniek | Provenance/noot |
|---|---|---|
| `joborder_id` | `bron_referentie` | JSON-API; stabiele detailroute. |
| `title`, `description`, `teaser` | `titel`, `beschrijving`, `samenvatting` | JSON-API; beschrijving is HTML-escaped. |
| `company` | `opdrachtgever_naam` | JSON-API; echte eindklant. |
| `company_city`, `address_city` | `locatie_plaats` | JSON-API. |
| `hours` | `uren_per_week` | Stringrange, bijvoorbeeld `24-28`. |
| `max_rate`, `salary` | `tarief_max`, `tarief_tekst` | `max_rate` is slechts bij 7/50 gevuld. |
| `start_date`, `time_deadline`, `time_published` | `startdatum`, `sluitingsdatum`, `gepubliceerd_op` | Unix-tijden. |
| `duration`, `workplace_type`, `status` | `looptijd`, `werkvorm`, `status_bron` | JSON-API. |

Contact- en recruiter-/sourcer-velden worden niet genormaliseerd of gelogd.

## Ingest-patroon

- Doe maximaal één listing-call per enkele uren; de response bevat alle 50 opdrachten en heeft geen paginering.
- Bewaar de ruwe observatie, schema-check de response en diff op `joborder_id` plus payload-hash.
- Schakel bij schema-/endpointfalen over op browser-rendered details; poll niet agressiever tijdens een storing.

## Licentie en voorwaarden

- `robots.txt` staat de publieke site toe; de sitemap bevat geen job-URL's. Het Olliworks-portaal is uitgesloten en is niet nodig.
- Er is geen ToS-wall gezien. Houd de voorwaardenstatus desondanks expliciet in het bronregister vóór activatie.

## Risico's

1. Het private endpoint kan zonder aankondiging wijzigen of verdwijnen.
2. De fallback vereist browser-rendering omdat de site geen SSR gebruikt.
3. `max_rate` is meestal leeg; `baseSalary=0/HOUR` in de ItemList is een placeholder.

## Known-hash short-circuit (RJC-357 / RJC-401)

`listingHashCoversDetail: true` — de fetch her-serialiseert de listing-job zonder tweede request. `hashOnefellowListingItem` dekt elk veld dat de normaliser leest (incl. `time_deadline` → `sluitingsdatum` en `status` → lifecycle). Bewust NIET gehasht: `time_published`/`time_updated` — de normaliser leest ze niet, dus een re-poll die alleen die timestamps bumpt mag geskipt worden (zelfde DEC-008-redenering als het hash-docblock).

## Durable cohort (CTP-640, bewezen 2026-09-25)

Onefellow is bewezen op het duurzame ingestpad (`curated.durable_job` +
`POLLER_DURABLE_BRONNEN`) als onderdeel van de L3d mixed-adapter-cohort
(Harvey Nash + Hays + Need Staffing IT + Onefellow). De connector en
source-definitie zijn ongewijzigd — de migratie is een bewijslast, geen
codewijziging.

**Live-probe 2026-09-25:** `GET
https://yhjktxqtoyeruztiwupf.supabase.co/functions/v1/olli-jobs?action=list`
→ 200, ~1,0 MB JSON `{jobs: [...]}` — het private endpoint is live en in
dezelfde vorm als de fixture-opname.

**Resume-contract** (`packages/connectors/src/onefellow/durable-cohort-l3d.spec.ts`,
8 specs): het endpoint levert álle open opdrachten in één call —
`discover()` geeft `hasMore: false` met een inert `checkpoint: {}`; er is
géén pagina-cursor en géén detail-endpoint. `fetch()` her-serialiseert de
gewhitelistete listing-job (`fetchUsesNetwork: false`), dus de listing-job
ÍS de change vector. `listingHashCoversDetail: true` + de
registry-doorgifte van `knownHashes` betekent: een ongewijzigde
herhaal-poll skipt elke fetch en schrijft NUL observaties — dedupe zit
vóór de recorder, een laag eerder dan de cohort-siblings. Een herval
herleest de hele response en de replay key absorbeert al-persisteerde
items — exact-één, geen verlies. Head-inserts ziet de herval direct; er is
geen read-pages blind spot.

**Fixture-corpus (eerlijk):** de committed listing-fixture is de echte
JSON-opname met 6 jobs (920, 1029, 1030, 1032, 944, 1006); er zijn géén
detail-fixtures want er bestaat geen detail-request — alle 6 persisteren.
Geen opgenomen reject-fixture.

**End-to-end op de echte pipeline** (fixture-client, `ji_test_iso_*`-Postgres,
`apps/worker/src/poller/l3d-cohort.integration.spec.ts` — 5 specs per bron,
groen): offer → `runDurableBronJobConsumer` → `runBronIngestPipeline` →
observaties, `source_record`s, curated `aanvraag`-rijen en `outbox_event`s;
herhaalde run → NUL observaties (known-hash skip vóór de recorder), geen
duplicaten of extra versies; gewijzigde listing-job-titel → `changed` →
nieuwe `aanvraag_versie` + bijgewerkte curated rij; gefaalde listing-read →
run `failed` (`DISCOVER_FAILED`) → herval via `reopenFailed` (fence +1) →
volledige her-enumeratie; abort mid-fetch → `failed`
(`RAW_STORE_WRITE_FAILED`, CTP-490) → retake exact-één.

**UI-bewijs (geseedde stack):** wegwerp-DB `ji_ctp640_visual_l3d` (door deze
lane aangemaakt), aanvragen gesaaid via het echte duurzame pad met
Manticore-drain (`SEARCH_PROJECTOR=worker`), API `localhost:3000` + web
`localhost:3001` zonder `NEXT_PUBLIC_USE_FIXTURES`: `/jobs` toont de
Bron-facet met alle vier de bronnen incl. tellen. De opnames zijn ouder
dan hun sluitingsdatum, dus de pipeline zette de 6 rijen terecht op
`closed`; voor de capture zijn de geseedde curated rijen op `active` met
een toekomstige sluitingsdatum gezet en opnieuw geprojecteerd — fixtures
ongewijzigd, alleen weergavestaat. Captures: `/tmp/ctp640-visual/` (H.264
MP4 + PNG, geopend en in frame bevestigd).

**Canary en rollback:** `POLLER_DURABLE_BRONNEN` per bron toevoegen, één
tegelijk, ná de L3a/L3b/L3c-cohorten. Rollback = slug uit de vlag halen;
in-flight jobs lopen leeg, geen dubbele scheduling. `ONEFELLOW_LIVE` blijft
uit — dit bewijs is fixture-only. Operator-canary en release-gate blijven
open.
