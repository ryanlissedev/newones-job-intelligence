# Techniekwerkt — ingest-recept

Status: **connector toegevoegd** — adapter-categorie `json-ld` met
`detailSynthesizer` (CTP-551).

## Endpoints

| Doel | URL | Opmerking |
|---|---|---|
| Sitemap | `GET https://media.techniekwerkt.nl/sitemaps/vacatures.xml.gz` | 8.245 vacature-URL's (opname 2026-09-17), allemaal `https://techniekwerkt.nl/nl/vacature/<slug>-<id>`; gzip-compressed (`application/x-compressed`, géén `Content-Encoding`) — de gedeelde live-reader decomprimeert op magic bytes. |
| Detail | `https://techniekwerkt.nl/nl/vacature/<slug>-<id>` | Geen JobPosting JSON-LD (alleen `BreadcrumbList`). De vacature zit gestructureerd in `<script id="vike_pageContext" type="application/json">` onder `pageProps.job`. |

## Correctie op de Wave-1B-inventaris

De eerdere probe (CTP-551, `docs/sources/inventory/boards-wave1b.md`) verbaalde
NO-JSONLD en "geen in-page state" omdat ze alleen naar
`__NEXT_DATA__`/`__NUXT__`/microdata keek. Het Vike `pageContext`-script zit er
wél — live capture wint; het verdict is hiermee gecorrigeerd naar buildbaar via
framework-state-synthesis (dezelfde route als ASML's `__NEXT_DATA__`).

## Veldmapping en datakwaliteit

| `pageProps.job` | Canoniek | Provenance/noot |
|---|---|---|
| `original_functiontitle` | `title` → titel | Letterlijk. |
| `description` | beschrijving | HTML, letterlijk. |
| `original_companyname` | `hiringOrganization.name` → opdrachtgeverNaam | Werkgever die de vacature plaatste (bv. `Unica`). |
| `city` | `jobLocation.address.addressLocality` → locatieTekst | `addressCountry` `NL` — het is een NL-board. |
| `id` | `identifier` + `labelBlock.referentienummer` | Numeriek job-id. |
| `updated_at` | `labelBlock.gewijzigdOp` | Laatste wijziging, géén publicatiedatum — `publicatiedatum` blijft UNKNOWN. |
| `industry` / `experience` / `education` / `contract` / `salary` namen | `labelBlock.branche` / `ervaring` / `opleiding` / `dienstverband` / `salaris` | Alleen wanneer de bron ze vult; `salary` en `contract` waren leeg op alle vier gesamplede pagina's (2026-09-17) en mappen nooit naar `tarief`/`employmentType` — de vorm is ongeverifieerd. |
| `apply_email`, `contact_name`, `contact_phone_number` | — niet overgenomen | Contact-PII wordt geminimaliseerd (DEC-008); fixtures zijn mechanisch geredacteerd. |

De sitemap bevat uitsluitend URL-metadata. Daarom is `listingHashCoversDetail:
false` en worden known hashes niet doorgestuurd. `crawlDelayMs` is 2000 en
`voorwaardenStatus` blijft `te_toetsen`: robots staat discovery toe (alleen
`/*ad-click/`, `/*apply-redirect/`, `/*solliciteren/`, `/cdn-cgi/` en
`/*page=*` disallowed). De drie vastgelegde detailpagina's zijn echte
HTTP-opnames; strips zijn uitsluitend mechanisch (scripts behalve
`ld+json`/`vike_pageContext`, style, svg, nav) en contact-e-mail/telefoon is
geredacteerd.



## Durable JSON-LD-cohort (CTP-642, bewezen 2026-09-25)

Techniekwerkt is bewezen op het duurzame ingestpad (`curated.durable_job` +
`POLLER_DURABLE_BRONNEN`) als onderdeel van de L3f JSON-LD-cohort (Randstad
+ Techniekwerkt). De connector en source-definitie zijn ongewijzigd — de
migratie is een bewijslast, geen codewijziging.

**Live-probe 2026-09-25:**
`https://media.techniekwerkt.nl/sitemaps/vacatures.xml.gz` → 200, ~116 KB
gzip (`application/x-compressed`, geen `Content-Encoding` — de live reader
inflate't op magic bytes, zoals de config-docblock beschrijft).

**Resume-contract** (`packages/connectors/src/json-ld/durable-cohort-l3f.spec.ts`,
6 + 2 specs): `discovery.kind` is `sitemap` — één sitemap levert het hele
corpus; `discover()` geeft alles terug met `hasMore: false` en een inert
`checkpoint: {}`. Er is géén pagina-cursor: een duurzame herval
her-enumereert élke detail-URL en herfetched élke detailpagina; exact-één
draait op de observatie-replay sleutel (`scrapeRunId + bronReferentie +
contentHash`).

**detailSynthesizer (het verschil met de cohort-siblings):** de opgenomen
detailpagina's dragen GEEN `ld+json` JobPosting — alleen een
BreadcrumbList plus de Vike SSR-payload `vike_pageContext.pageProps.job`.
`synthesizeJobPostingFromVike` bouwt de JobPosting daaruit op (titel,
opdrachtgever, plaats, `referentienummer` in de labelBlock). Twee extra
specs pinnen dat: de opgenomen fixture levert via de synthesizer een echte
JobPosting (`Leerling Monteur Werktuigbouwkunde`, ref 973440), én een body
zónder de vike-structuur synthetiseert naar niets — de connector reject
dan fail-closed met `no JobPosting JSON-LD found on detail page`, nooit
een payload-lose persist.

**Fixture-corpus (eerlijk):** de committed sitemap-fixture (deflated) is
de echte opname en parset naar 3 vacature-URL's; alle drie zijn
detail-backed (`973440`, `973508`, `973447`). Geen opgenomen
reject-fixture.

**End-to-end op de echte pipeline** (fixture-client, `ji_test_iso_*`-Postgres,
`apps/worker/src/poller/json-ld-cohort-l3f.integration.spec.ts` — 5 specs
per bron, groen): offer → `runDurableBronJobConsumer` →
`runBronIngestPipeline` → observaties, `source_record`s, curated
`aanvraag`-rijen en `outbox_event`s — het gepersisteerde payload ís de
gesynthetiseerde JobPosting; herhaalde run → `unchanged`; gewijzigde
payload → `changed` → nieuwe `aanvraag_versie` + bijgewerkte curated rij;
gefaalde listing-read → run `failed` (`DISCOVER_FAILED`) → herval via
`reopenFailed` (fence +1) → volledige her-enumeratie; abort mid-item →
`failed` (`RAW_STORE_WRITE_FAILED`, CTP-490) → retake exact-één.

**UI-bewijs (geseedde stack):** wegwerp-DB `ji_ctp642_visual_l3f` (door
deze lane aangemaakt), aanvragen gesaaid via het echte duurzame pad met
Manticore-drain (`SEARCH_PROJECTOR=worker`), API `localhost:3000` + web
`localhost:3001` zonder `NEXT_PUBLIC_USE_FIXTURES`: `/jobs` toont de
Bron-facet met beide bronnen incl. tellen. Captures:
`/tmp/ctp642-visual/` (H.264 MP4 + PNG, geopend en in frame bevestigd).

**Canary en rollback:** `POLLER_DURABLE_BRONNEN` per bron toevoegen, één
tegelijk, ná de L3a–L3e-cohorten. Rollback = slug uit de vlag halen;
in-flight jobs lopen leeg, geen dubbele scheduling. `TECHNIEKWERKT_LIVE`
blijft uit — dit bewijs is fixture-only. Operator-canary en release-gate
blijven open.

## Voorwaarden

- robots.txt: media.techniekwerkt.nl: HTTP 200, geen Disallow op connectorpaden (/sitemaps/, /nl/vacature/), geprobed 2026-09-25
- ToS/gebruiksvoorwaarden: niet gevonden
- Besluit: `te_toetsen`
- Besluitnemer en datum: open voor Robbie (geen besluit vastgelegd)
