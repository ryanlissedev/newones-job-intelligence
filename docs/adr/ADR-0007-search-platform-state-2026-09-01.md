# ADR-0007 — Zoekplatform-staat 2026-09-01

- Status: Accepted (staat-vastlegging, geen nieuw besluit)
- Datum: 2026-09-01
- Eigenaar: Job Intelligence platform
- Gerelateerd: ADR-0001, ADR-0003, ADR-0004, ADR-0005, ADR-0006, RJC-377, RJC-378, RJC-382, RJC-383, RJC-386, RJC-387, RJC-388, RJC-389, RJC-390, RJC-391, RJC-392, RJC-394, RJC-397, RJC-398

## Wat dit document is

Dit ADR legt geen nieuw besluit vast. Het beschrijft wat de zoek-, ingest- en
opslagarchitectuur op `main` **is**, na één dag waarin 15 PR's (#87–#102)
landden bovenop [ADR-0006](ADR-0006-neon-as-system-of-record.md) (Neon als
production system of record, Accepted 2026-08-31). Het doel is dat ADR's en
runbooks niet meer naar verouderde staat verwijzen. Waar een cijfer of
constatering hieronder staat, komt die uit een gecommit rapport of een
gemerged PR — niet uit aanname.

## Datastroom vandaag

```
poll-bron (worker/Trigger.dev)
  → raw object store (S3-compatible of filesystem, RJC-386)
  → normalise/curate (Neon, source of truth)
  → curated.outbox_event (SearchVersion sequence, RJC-384/RJC-389)
  → [SEARCH_PROJECTOR=worker: inline drain in dezelfde worker-run]
  → [SEARCH_PROJECTOR=onbox: losstaand projectorproces on-box, RJC-387]
  → Manticore 6.3.8 (private, `aanvragen`-index)
  → apps/server: SearchAdapter → cache (Redis of in-process, RJC-388) → API
```

Neon is production system of record voor Postgres (ADR-0006). Manticore
blijft privé; RJC-387 lost het "cloud-worker moet Manticore bereiken"-deel
van [ADR-0005](ADR-0005-trigger-dev-database-reachability.md) op door de
drain van de worker te scheiden en op een on-box projectorproces te draaien
in plaats van Manticore-netwerktoegang aan de cloud-worker te geven. De
worker stopt na de outbox-commit; de projector leest de Neon-outbox over TLS
en schrijft lokaal naar Manticore (`docs/runbooks/search-projector.md`).

Ruwe connectorpayloads gaan naar een gedeelde S3-compatible object store
(`RAW_S3_BUCKET` gezet) of, buiten productie, een filesystem-fallback
(`docs/runbooks/raw-object-storage.md`, RJC-386). Productie weigert te
starten op de filesystem-backend.

## Invarianten die nu worden afgedwongen

- **SearchVersion-generatie en watermark.** `curated.search_projection_checkpoint`
  (migratie 0006) houdt `generation`, `applied_sequence` en `schema_hash` bij;
  `curated.outbox_event.sequence_number` (migratie 0006, `GENERATED ALWAYS AS
  IDENTITY`) is de monotone volgorde waarover de drain itereert.
  `query_snapshot` bindt een selectie aan `search_generation` en
  `search_applied_sequence` (migratie 0007, RJC-385) zodat een snapshot-goedkeuring
  vastligt op het exacte staat waartegen hij is gemaakt.
- **Schema-hash stopt de drain, niet het schrijven.** Wanneer
  `SEARCH_SCHEMA_HASH` (`packages/search/src/version.ts`) niet meer matcht met
  de checkpoint, gooit `drainPostgresOutbox` `SearchIndexSchemaMismatchError`;
  de projector stopt met vorderen, Manticore blijft de oude index serveren,
  er gaat niets verloren. Herstel via `bun run search:new-generation`
  (`tools/manticore/start-search-generation.ts`) — zie
  `docs/runbooks/search-schema-migration.md`.
- **Productie weigert vluchtige of onbereikbare stores.** Filesystem-raw-store
  in productie (RJC-386) en volatiele stores in het algemeen (RJC-390,
  `assertProductionPersistence`/de productie-guard in
  `apps/server/src/slice-a-registry.ts`) laten de server niet starten.
  Redis-onbereikbaarheid **bij boot in productie** weigert eveneens te
  starten (`createResultCache`); buiten productie, of wanneer Redis **na**
  boot wegvalt, degradeert de server naar de in-process cache in plaats van
  plat te gaan (RJC-388, `docs/runbooks/readiness.md`).
  De vergelijkbare `postgres-restore-drill`-CI-job blijft alleen bewijs voor
  de lokale/CI wal-g-restore-lane; hij zegt niets over Neon-restore
  (ADR-0006, "Nieuwe verplichtingen", punt 2).
- **Per-rij claims op de outbox.** Migratie 0008 voegt `claimed_until`,
  `retry_count`, `last_error`, `dead_lettered_at` en `claim_token` toe aan
  `curated.outbox_event`, plus een eigen `curated.search_projection_state`
  per aggregate (`applied_sequence`, `generation`, `projection_hash`). Dit
  draagt de bulkprojector (RJC-389/RJC-392): rij-niveau claims, coalescing van
  meerdere events per aggregate tot één projectie, projectie-hashes om
  no-op-writes te detecteren, en dead-lettering na herhaalde fouten
  (`docs/runbooks/search-projector.md`, sectie "Bulk drain internals" wijst
  naar `packages/db/src/outbox-drain.ts`).
- **Server-side sort/filter/pagination met echte totalen.** RJC-378 (PR #91)
  verplaatst filtering/sortering/paginering vóór de top-k in de engine in
  plaats van client-side na te filteren, met `SEARCH_SCHEMA_HASH`-bump naar
  `aanvragen-v2` (nieuwe attributen `locatie`, `sluitingsdatum`) en een
  bugfix in Manticore's top-level `filter`-gedrag. Dit is exact het eerste
  punt uit het externe zoekarchitectuur-advies
  (`docs/research/search-architecture-advisory-2026-08-31.md`).

## Operator-runbooks

- [`docs/runbooks/search-projector.md`](../runbooks/search-projector.md) —
  on-box projector: deploy-contract, supervisie, advisory lock,
  gedragstabel bij storingen.
- [`docs/runbooks/raw-object-storage.md`](../runbooks/raw-object-storage.md) —
  S3-vs-filesystem raw store, content-addressing, digest-validatie, lokale
  MinIO-compose.
- [`docs/runbooks/readiness.md`](../runbooks/readiness.md) — `/readyz`
  component-gewijs: postgres, manticore, rawObjectStore, redis,
  searchProjection, met vaste `reason`-strings en geen gelekte credentials.
- [`docs/runbooks/search-schema-migration.md`](../runbooks/search-schema-migration.md) —
  stappenplan bij een `SEARCH_SCHEMA_HASH`-wijziging: RT-attributen
  toevoegen, nieuwe generatie starten, reindexeren, verifiëren.

## Open besluiten en hun tickets

- **Manticore-engineversie (6.3.8 vs 29.0.2) — RJC-382.** Beide engines zijn
  gemeten; de keuze is aan Ryan. Relevantie
  (`docs/research/manticore-29-comparison-2026-09-01.md`): in-memory
  baseline recall@20 0,457 (regressie-check, byte-identiek gehouden over
  meerdere PR's); 6.3.8 macro recall@20/nDCG@10 0,477/0,425; 29.0.2 (met en
  zonder infix, identiek tot zes decimalen) 0,488/0,482. De macro-winst
  verbergt een echte regressie: categorie `semantic-synonym` daalt van 0,188
  naar 0,000 op 29.0.2 — twee queries (`se-jeugdzorg`, `se-duurzameenergie`)
  verliezen hun enige relevante hit door een libstemmer_nl-stemmingsverschil.
  `min_infix_len = 2` mat nul effect, ook op de query waarvoor hij was
  toegevoegd. Latency
  (`docs/research/manticore-latency-2026-09-01.md`, 20k documenten, laptop):
  beide engines halen de SLO (p95 ≤ 100 ms) ruim; op de profile-queryset is
  29-infix sneller op boolean queries (~3–6 ms p95 vs ~40 ms op 6.3.8), maar
  op de golden-queryset is er geen schone (load ≤ 6 start en einde) meting
  voor 29-infix — alleen een "mixed"-run. Een 200k-run op de Hetzner-box,
  beide engines, is de uitstaande vervolgstap; DEC-004's SLO is over het
  200k-profiel gedefinieerd, niet over de gemeten 20k.
- **Harvey Nash-deadline — RJC-377.** `facts.deadline` (recruiter-inzendcutoff)
  vs. `jsonLd.validThrough` (listing-geldigheid) — de code gebruikt interim
  `validThrough` als conservatieve LATER-grens; de waarschijnlijk juiste fix
  (`deadline === UNKNOWN ? validThrough : deadline`) is gedocumenteerd in de
  `RATIONALE (revised after Fable review, RJC-377)`-docblock in
  `packages/application/src/normalise/harveynash.ts`, maar niet toegepast, in
  afwachting van bevestiging (`docs/research/closing-dates-per-source-2026-09-01.md`).
- **NODE_ENV/SEARCH_PROJECTOR deploy-env.** `SEARCH_PROJECTOR` default is
  `"worker"` (huidig gedrag, ongewijzigd); productie moet expliciet
  `SEARCH_PROJECTOR=onbox` zetten én het losstaande projectorproces starten
  — één zonder het ander laat de outbox onopgemerkt oplopen of laat de
  worker alsnog om `MANTICORE_URL` vragen dat hij niet heeft
  (`docs/runbooks/search-projector.md`, sectie "Deploy contract").
- **Recruiter judgments voor het golden set — PR #100 → RJC-398 (graderen,
  eigenaar Ryan).** PR #100 levert `bun run relevance:export`/
  `relevance:import` zodat recruiters (niet engineers) queries graden
  (2/1/0-schaal) via een CSV-rondgang; het graden zelf is nog niet gedaan
  (30–60 min voor 43 queries op het huidige 33-documentcorpus, PR-body "What
  this does NOT do").
- **Actief/archief-splitsing — RJC-383 (actief/archief) start na RJC-397
  (missed polls).** Uit het externe advies
  (`docs/research/search-architecture-advisory-2026-08-31.md`): standaard
  zoeken in `vacancies_active`, archief als expliciete optie. Hangt samen met
  de sluitingslogica (RJC-376/RJC-377). Nog niet opgepakt in deze ronde.

Ticketnummers verwijzen naar Linear-team RJC; de repository bevat ze niet
(behalve waar een commit- of PR-titel er zelf naar verwijst).

## Deploy-contractdeltas

Nieuwe omgevingsvariabelen sinds ADR-0006:

| Variabele | Waar | Doel |
|---|---|---|
| `RAW_S3_BUCKET` | server + worker | Selecteert de S3-backend voor raw objects; ontbreken → filesystem-fallback (alleen buiten productie). |
| `RAW_S3_ENDPOINT` | server + worker | S3-compatible endpoint (lokaal MinIO); leeg voor echte AWS S3. |
| `RAW_S3_REGION`, `RAW_S3_ACCESS_KEY_ID`, `RAW_S3_SECRET_ACCESS_KEY` | server + worker | S3-credentials/regio. |
| `REDIS_URL` | server | Optioneel; onbereikbaar bij boot in productie → weigert te starten; buiten productie, of wegvallen na boot → degradeert naar in-process cache. |
| `SEARCH_PROJECTOR` | worker | `"worker"` (default, huidig gedrag) of `"onbox"` (nieuw, RJC-387). |
| `MANTICORE_URL` | **alleen op de projector-host** in onbox-modus; niet meer nodig op de cloud-worker in die modus | Manticore-adres voor de projector; in `worker`-modus blijft dit op de worker zelf staan (ongewijzigd). |
| `PROJECTOR_DATABASE_URL` | projector | Directe (niet-gepoolde) Postgres/Neon-verbinding voor de session-level advisory lock; gewone dataqueries blijven via `DATABASE_URL` lopen. |

## Gevolgen

- Deze staatsvastlegging vervangt geen enkel eerder ADR-besluit; hij
  documenteert de implementatie van reeds geaccepteerde besluiten
  (ADR-0004/0005/0006) en van tickets die nog niet in een ADR stonden.
- Toekomstige runbook- of ADR-wijzigingen aan de hier genoemde componenten
  horen dit document bij te werken of te superseden, niet stilzwijgend te
  laten verouderen.
- De twee resterende open besluiten met het meeste gewicht zijn de
  Manticore-engineversie (RJC-382, wacht op een 200k-Hetzner-run) en de
  Harvey Nash-deadlinekeuze (RJC-377, wacht op bevestiging door Ryan).
