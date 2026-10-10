# Striive — ingest-recept (geverifieerd 2026-08-31)

Status: **connector gebouwd en gemerged** (PR #69, RJC-363); niet geactiveerd — `STRIIVE_LIVE` staat ongezet en `voorwaarden_status` blijft `te_toetsen`. Adapter-categorie `json-api`; 109 open opdrachten (live capture 2026-08-31, momentopname). Lezen is publiek; Auth0 staat alleen voor reageren en voorwaardenstatus is nog te toetsen.

> **Correctie 2026-08-31:** De oorspronkelijke probe vermeldde dat de JSON-listing alle open opdrachten in één call teruggeeft (~100). Een live capture op dezelfde datum toonde paginering: `total` 109, 25 records per pagina, 5 pagina's (`page` 1..5; `page=6` leeg). De endpointtabel en het ingest-patroon hieronder zijn hierop gecorrigeerd.

## Endpoints

| Doel | URL | Opmerking |
|---|---|---|
| Listing | `GET https://striive.com/nl/opdrachten` | Angular SSR; 27 MB HTML, eerste 25 records in TransferState (geen volledige set). |
| JSON-listing | `GET https://striive-cms.codebridge.nl/api/jobs?open=true&page=<n>` | Publiek, CORS-open, geen auth-header waargenomen; pagineert met `page` (1-indexed; `page=0` en `page=1` geven dezelfde eerste pagina); `{total:<n>,data:[…]}`, 25 records per pagina. Live capture 2026-08-31: `total` 109, 5 pagina's. |
| Detail | `GET https://striive.com/nl/opdrachten?id=<uuid>` | Publieke detailtekst; JobPosting JSON-LD is malformed. |

## Veldmapping → canoniek `aanvraag`

| Striive | Canoniek | Provenance/noot |
|---|---|---|
| `id`, `referenceCode`, `referenceCodeClient` | `bron_referentie`, `bron_specifiek.referenties` | JSON-API. |
| `title`, `content` | `titel`, `beschrijving` | JSON-API; content is HTML. |
| `clientName` | `opdrachtgever_naam` | JSON-API. |
| `location`, `regionLocation` | `locatie_omschrijving`, `bron_specifiek.geo` | JSON-API; GeoJSON-point. |
| `hoursPerWeekMin/Max` | `uren_per_week_min/max` | JSON-API. |
| `startDate`, `endDate` | `startdatum`, `einddatum` | JSON-API. |
| `closingDateInvoice`, `closingDateClient` | `bron_specifiek.supplier_deadline`, `sluitingsdatum` | Twee verschillende deadlines. |
| `broker`, `source` | `bron_specifiek.broker`, `bron_specifiek.source` | JSON-API. |
| `hourlyRateMin/Max`, `monthlyRateMin/Max`, `hasMaxRate`, `rateType` | `tarief` (uur/maand) | CTP-524, F09: whitelisted; niet langer DEC-008-uitgesloten (commerciële feiten, geen PII). Op 2026-08-31 stonden alle waarden op nul/false in de volledige 109-record capture -- dat maakte ze toen onbruikbaar, geen permanente uitsluiting. `eenheid` volgt structureel uit welk veldpaar (uur/maand) daadwerkelijk >0 is; `rateType`'s codering is nooit gedocumenteerd (alleen `0` live gezien) en stuurt de mapping niet. Een waarde van exact `0` telt als afwezig, nooit als een echt €0-tarief. |
| `jobType` | `bron_specifiek.contract_type` | CTP-524, F06: whitelisted 2026-09-15; `null` in alle 25 records van de live capture van 2026-09-16, die nu volledig in de fixture staat (zie hieronder). Zie "CTP-524 vervolgonderzoek" hieronder. |
| `tags` (`tagNames` blijft ongebruikt) | `bron_specifiek.skills` | CTP-524, F15: whitelisted 2026-09-15 via `normaliseSkills`; `[]` in alle 25 records van de live capture van 2026-09-16, die nu volledig in de fixture staat; entry-vorm nooit gezien. Zie "CTP-524 vervolgonderzoek" hieronder. |

Recruiternaam, e-mail en telefoon worden niet genormaliseerd of gelogd.

## Ingest-patroon

- Loop de JSON-listing met `page=1,2,…` tot stop: een korte pagina (`data.length` < `STRIIVE_PAGE_SIZE`, 25) **of** het paginacap (`nextPage` > `STRIIVE_MAX_PAGES`, 40) — beide stopcondities zijn onafhankelijk; vertrouw niet op `total`-rekenwerk alleen.
- Diff op id plus payload-hash over alle verzamelde pagina's.
- Vermijd herhaald ophalen van de 27 MB SSR-listing; fetch detail alleen wanneer aanvullende openbare tekst nodig is.
- Log niet in: lezen vereist geen Auth0-account.

## Licentie en voorwaarden

- `robots.txt` staat alles toe en heeft geen crawl-delay; de sitemap bevat geen individuele opdrachten.
- Een gebruikslicentie of bruikbare ToS-uitkomst staat niet in de probe. Houd `voorwaarden_status: te_toetsen` vóór activatie.

## Voorwaarden

- robots.txt: striive-cms.codebridge.nl: HTTP 200, geen Disallow op connectorpaden (/), geprobed 2026-09-25
- ToS/gebruiksvoorwaarden: zie "Licentie en voorwaarden" hierboven
- Besluit: `toegestaan`
- Besluitnemer en datum: Ryan (operatorbesluit 2026-09-03, live testimport productie)

## Risico's

1. JobPosting JSON-LD is malformed en niet parsebaar.
2. De SSR-listing is 27 MB en bevat slechts de eerste 25 records.
3. Tariefvelden zijn in de probe niet bruikbaar.

## Known-hash short-circuit (RJC-357 / RJC-401)

`listingHashCoversDetail: true` — de fetch her-serialiseert de DEC-008-projectie zonder tweede request, en `hashStriiveListingItem` hasht alle velden van `StriiveJob` (het docblock daar zegt dit expliciet; CTP-524 breidde dit uit met 8 sleutels: 6 tariefvelden plus `jobType` en `tags`). Alles wat de normaliser leest (incl. `closingDateClient` → `sluitingsdatum`) zit dus in de listing-hash. Een nieuw `StriiveJob`-veld hoort ook in de hash. Omdat de hash-vorm veranderde, hasht elke Striive-rij bij de eerstvolgende poll opnieuw anders dan de vorige run — eenmalige churn van ~104 rijen, geen echte inhoudswijziging.

## CTP-524 vervolgonderzoek: contract_type en skills (heropgenomen 2026-09-16)

De DEC-008-uitsluiting gold nooit voor `contract_type` of `skills` — DEC-008 is raw-data-minimalisatie voor persoonsgegevens (`docs/IMPLEMENTATION_BACKLOG.md`), geen verbod op commerciële velden. Eén beleefde, live capture van `GET /api/jobs?open=true&page=1` op 2026-09-16 (25 records, `total: 98`) bevestigt de echte sleutelnamen: `jobType` (engagement/contract-type, VMS-conventie) en `tags`/`tagNames` (skills-achtig). Beide staan structureel in het schema — elk van de 25 records heeft de sleutel — maar zijn op capture-moment leeg: `jobType: null` en `tags: []` in alle 25 records, net als `serviceType`, `requirements` en `orderClassificationType`. De volledige pagina staat gesaniteerd in `fixtures/connectors/striive/listing-live.json` (opgenomen met `bun tools/fixtures/record.ts`; recruiter-/contactvelden en base64-afbeeldingen mechanisch verwijderd op sleutelnaam, DEC-008). Dat bestand bevat nu **alle 25 records** van die pagina — de "alle 25 records"-uitspraken hierboven zijn er dus uit na te rekenen — en draagt de echte fetch-timestamp als `capturedAt`.

`docs/research/source-probes-2026-08-31.md` §7 noemt in proza dat records "eisen" bevatten; dat blijkt de vrije-tekst `<b>Eisen:</b>`-paragraaf binnen `content` te zijn (bevestigd in dezelfde live capture), geen apart structured veld — dat blijft GAP_ENRICH-territorium (CTP-482).

Beide velden zijn nu gewhitelist en gemapt met dezelfde eerlijke future-proofing als de tariefvelden (CTP-524 F09): `jobType` → `bron_specifiek.contract_type`, `tags` → `bron_specifiek.skills` via `normaliseSkills` (niet-string entries worden verwijderd; de vorm van gevulde `tags`-entries is nooit live gezien). F06/F15 zijn daarmee **FIXED in code**, maar de huidige live populatie levert overal `null`/`[]` — ABSENT_SRC in de praktijk tot een broker deze velden daadwerkelijk publiceert.
