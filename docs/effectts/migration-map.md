# EffectTS — uitvoerbare projectbrede migratiekaart

- Status: uitvoerbaar plan plus A0-flowregister (CTP-617); migratie en Trigger-exit zelf **niet** voltooid
- Peildatum: 2026-09-19 — huidige docs-basis `79459a0` (A0 wijzigt geen runtimecode)
- Besluit: [ADR-0014](../adr/ADR-0014-effectts-project-wide-adoption.md)
- Platformcontract: [ADR-0015](../adr/ADR-0015-platform-integration-contracts.md)
- Baseline: [ADR-0013](../adr/ADR-0013-effectts-platform-baseline.md) + [`docs/evidence/ctp-454/`](../evidence/ctp-454/)
- Wire-contract eerste adapters: [json-ld-spott-wire-contract.md](json-ld-spott-wire-contract.md)
- Productie: **OFF** tot aparte gecontroleerde release per slice

Uitstel van een latere slice wijzigt de projectbrede Effect-richting niet.

## CTP-617/A0 — doelgrens, beslisstatus en bewijsregister

JI en Candidate Intelligence zijn zelfstandig toegankelijke apps/modules. Een
Candidate-only gebruiker hoeft JI niet te openen. Een platform-shell mag beide
tonen en gedeelde auth/UI-contracten gebruiken, maar deze kaart beslist niet dat
ze één deployment, tenantmodel of database delen. CI blijft readiness onder
CTP-345/CI0; er wordt in deze kaart geen CI-code gebouwd.

Nieuwe first-party backend-I/O loopt doelmatig via Effect Services/Layers en
Effect Schema als canonieke contractbron. React, Better Auth, Drizzle en
provider-SDK's blijven smalle adapters. Trigger.dev is alleen tijdelijke interop
voor bestaande taken. De oude Trigger-durabilityrichting, Python/FastAPI/
Pydantic-runtime en Python/LangGraph-runtime zijn als doelrichting superseded of
niet aangenomen; zie de traceerbare tabel in [ADR-0014](../adr/ADR-0014-effectts-project-wide-adoption.md).

De actuele uitvoerder is niet overal dezelfde als de historische adapter: de
on-box poller bezit nu polling en curatie; Trigger blijft alleen voor de vier
retained jobs die in de [on-box poller runbook](../runbooks/onbox-poller.md)
staan. Een cutover per flow mag pas één actieve uitvoerder, replay en rollback
bewijzen.

### Flowregister

Een status `opt-in` beschrijft bestaand canary- of adapterwerk. Het is geen
claim dat de volledige flow op Effect draait. Flags zijn bestaande flags waar ze
al bestaan; een nog niet bestaande flag blijft `TBD` en mag niet door deze docs
worden geïnterpreteerd als implementatieopdracht.

| Flow | Write- en operationele eigenaar | Runtime/doelgrens | Contract/version | Flag | Status op A0 | Bewijs of open gate |
| --- | --- | --- | --- | --- | --- | --- |
| Ingest | `@ji/application` bezit JI-mutaties; `@ji/connectors` bezit provider-wire; worker bezit job-invocatie | Effect Services/Layers voor provider-I/O en joblogica; `@ji/db` blijft persistence-owner | Bestaande source/application-contracten; A0-doel `v1` | `JI_EFFECT_WORKER`; connector/application cutover `TBD` | **opt-in gedeeltelijk**; bestaande Trigger-entrypoints nog actief | Connector/application slices en CTP-614/622/633 moeten parity, recovery en brongebonden reconciliation bewijzen |
| Search | `@ji/search` bezit index/readmodel; JI Postgres blijft SoR | Effect HTTP service rond `SearchAdapter`; outbox/checkpoint/fencing blijven expliciete persistencegrenzen | Search-adapter- en outboxcontracten; bestaande payloads versioned | geen flag | **default** sinds CTP-627; native fallback verwijderd | CTP-472/479, ADR-0007/0009, E0 zichtbaar resultaat en stale-writer-gate |
| Chat | `@ji/application` bezit capability/toolsemantiek; server bezit transport en authz | Effect-scoped chatturn achter de serverboundary; `streamText` blijft frameworkadapter | Capability/action-contract `v1`; transportversion via CTP-612 | `JI_EFFECT_SERVER`; chatflow-specifieke flag `TBD` | **readiness/partial**; CTP-612 behoudt chattransportmigratie | CTP-628 + bestaande chat-eigenaar; geen claim van volledige Effect-chat zonder e2e bewijs |
| Export | `@ji/application/export` bezit approval/action/receipt; `@ji/db` bezit ledger/crosswalk | Effect Services/Layers voor nieuwe I/O; provider-SDK achter connector; commit blijft approval-bound | `ji.aanvraag.export.commit.v1`; bestaande crosswalk/receipt-contracten | `JI_EFFECT_SERVER`/`JI_EFFECT_DB` alleen voor aanwezige boundary-canaries | **contract vastgelegd, cutover open** | CTP-458/459, Spott sandbox/tenantrechten, unknown-response reconcile en operatorbewijs |
| Feedback | De flow-owner van Company OS/actioncontract bezit feedbacksemantiek; JI bewaart alleen eigen receipts | Effect application service met versioned actioncontext; geen directe module-write vanuit UI/agent | Company OS action/evaluation-contract `v1` TBD | `TBD` | **proposed, niet gebouwd** | CTP-460 en menselijke/evaluatiebesluiten; geen fictieve runtime-PASS |
| Herstel | JI data owner + `@ji/db` bezitten SoR/backups; worker/operator bezit replay | Effect job/runtime orkestreert herstel; raw, receipts, outbox/inbox en DB blijven afzonderlijke bewijsgrenzen | Source-specifiek replay/restore-contract TBD | `JI_EFFECT_WORKER`; recovery-cutover `TBD` | **open gate** | CTP-625/632 en restorebewijs; RPO/RTO nog niet numeriek geaccepteerd |
| Toekomstige providers | Benoemde provider- en capability-owner; geen generieke platformwriter | Provideradapter via `@ji/connectors` en application port; read-only eerst | Per provider version TBD; nog geen contract vóór readiness | Per provider `TBD` | **discovery/readiness** | Integratie-inventaris, providercontract, tenantconsent, minimale velden, TTL en delete/correctie vóór code |

### Actuele uitvoerder en volledige coverage

Deze tabel voorkomt dat een bestaande Promise-client, een retained Trigger-task
of een bron die nog niet in een rolloutcohort zit als Effect-PASS wordt gelezen.
De bronregistry en de actuele runbooks zijn leidend; `CTP-633/Z5` sluit de
coverage pas wanneer actieve flows en bronnen afzonderlijk bewijs hebben of
formeel uit de geaccepteerde scope zijn gehaald.

| Pad | Actuele eigenaar/uitvoerder | A0-status | Gate en bewijs |
| --- | --- | --- | --- |
| Polling + curatie voor geregistreerde JI-bronnen | `apps/worker/src/poller/main.ts` on-box; `@ji/application`/`@ji/connectors` blijven flow-eigenaar | **Actuele executor**; vervangt de verwijderde Trigger `schedule-slice-a-polls`/`poll-bron`-route | CTP-614/E0, CTP-618/619, CTP-622/623/624 en CTP-633; geen claim dat alle cohorts al Effect-acceptatie hebben |
| Mercell, Indeed, LinkedIn Jobs en Werk.nl | `packages/application/src/sources/{mercell,indeed,linkedin,werk-nl}.ts` bezit sourceconfig/normalisatie; `packages/connectors/src/{mercell,indeed,linkedin,werk-nl}/` bezit connector en Promise-client; de poller bezit alleen jobinvocatie | **Provider/readiness open**; deze vier zijn niet als aparte L3a–L3f-rolloutcohort benoemd en mogen niet stilzwijgend groen worden verklaard | CTP-633 actieve-broncoverage plus bronvoorwaarden: Mercell POC/voorwaarden, Indeed challenge/account, LinkedIn productrechten en Werk.nl voorwaarden; bestaande connector is geen runtimebewijs |
| L3a JSON-LD-cohort: ASML, BAM, Eneco, Heijmans, NS | Gedeelde `packages/connectors/src/json-ld/` adapter; de vijf bronfiles en configs zijn ongewijzigd — de lane voegde alleen bewijs toe | **Fixture-bewijs op het duurzame pad**; operator-canary en releasegate blijven open, dus geen live-runtimeclaim | CTP-637: `json-ld/durable-cohort-l3a.spec.ts` (30 specs) + `poller/json-ld-cohort-l3a.integration.spec.ts` (25 specs op echte Postgres) + geseedde-stack UI-bewijs; rollout één bron tegelijk via `POLLER_DURABLE_BRONNEN` |
| L3b JSON-LD-cohort: DataJobs.nl, Unica, Vattenfall, VolkerWessels, Werken voor Nederland | Gedeelde `packages/connectors/src/json-ld/` adapter; de vijf bronfiles en configs zijn ongewijzigd — de lane voegde alleen bewijs toe | **Fixture-bewijs op het duurzame pad**; operator-canary en releasegate blijven open, dus geen live-runtimeclaim | CTP-638: `json-ld/durable-cohort-l3b.spec.ts` (30 specs) + `poller/json-ld-cohort-l3b.integration.spec.ts` (25 specs op echte Postgres) + geseedde-stack UI-bewijs; rollout één bron tegelijk via `POLLER_DURABLE_BRONNEN` |
| L3c mixed-adapter-cohort: CTM, Flinter, Freelancer.nl, Haert | Per-adapter connectors (`packages/connectors/src/{ctm,flinter,freelancer-nl}/` + gedeelde `json-ld/` voor Haert); bronfiles, configs en productie-wiring ongewijzigd — de lane voegde alleen bewijs toe | **Fixture-bewijs op het duurzame pad**; operator-canary en releasegate blijven open, dus geen live-runtimeclaim | CTP-639: `ctm/durable-cohort-l3c.spec.ts` (8 specs), `flinter/durable-cohort-l3c.spec.ts` (6), `freelancer-nl/durable-cohort-l3c.spec.ts` (8), `json-ld/durable-cohort-l3c.spec.ts` (5) + `poller/l3c-cohort.integration.spec.ts` (20 specs op echte `ji_test_iso_*`-Postgres) + geseedde-stack UI-bewijs; rollout één bron tegelijk via `POLLER_DURABLE_BRONNEN` |
| L3d mixed-adapter-cohort: Harvey Nash, Hays, Need Staffing IT, Onefellow | Per-adapter connectors (`packages/connectors/src/{harveynash,needstaffing,onefellow}/` + gedeelde `json-ld/` voor Hays); bronfiles, configs en productie-wiring ongewijzigd — de lane voegde alleen bewijs toe | **Fixture-bewijs op het duurzame pad**; operator-canary en releasegate blijven open, dus geen live-runtimeclaim | CTP-640: `harveynash/durable-cohort-l3d.spec.ts` (7 specs), `needstaffing/durable-cohort-l3d.spec.ts` (7), `onefellow/durable-cohort-l3d.spec.ts` (8), `json-ld/durable-cohort-l3d.spec.ts` (5) + `poller/l3d-cohort.integration.spec.ts` (20 specs op echte `ji_test_iso_*`-Postgres) + geseedde-stack UI-bewijs; harveynash en needstaffing hebben een echte pagina-cursor (herval hervat op de gecommitte pagina), hays en onefellow volgen single-pass contracten; rollout één bron tegelijk via `POLLER_DURABLE_BRONNEN` |
| Incomplete-field enrichment | `apps/worker/src/tasks/enrich-incomplete.ts` en retained `schedule-enrich-incomplete` op Trigger | **Retained Trigger path**; target is een eigen Effect-job per CTP-626/N2 | CTP-622 → CTP-626 → CTP-633; dry-run, actor/scope, idempotency en rollback/replay vóór live writes |
| Recovery/backfill | `backfill-neon-v1` blijft een one-shot Trigger/operatorpad; herstel via DB/ops en flow-owner | **Manual/retained path**, geen gewone pollingflow | CTP-625/R2 en CTP-632/O4; restorebewijs, RPO/RTO en geen resurrectie |
| Search outbox drain | On-box projector in productie; retained `drain-outbox`-task deferreert bij `SEARCH_PROJECTOR=onbox` | **On-box actuele executor**; Trigger-wrapper blijft interop voor andere modus | CTP-627/U3, stale-writer/replay-bewijs en CTP-633; geen dubbele actieve drain |

### Bestaande wave-crosswalk en T6/Z5-definitie

De uitvoeringsvolgorde volgt het bestaande [CTP-613-programma](https://linear.app/rcjt-studio/issue/CTP-613/effect-platformwaves-ji-afronden-trigger-verlaten-en-candidate)
en het [uitvoeringscontract](https://linear.app/rcjt-studio/document/effect-platformwaves-uitvoeringsplan-en-crabbox-contract-04922c890b87):

| Wave | Geordende slices | Betekenis voor deze kaart |
| --- | --- | --- |
| 0 | E0, X0, T0, A0, CI0 | bewijs, toolchain, platformgrens en Candidate-readiness |
| 1 | H1, S1, P1, B1 | eerlijke pollerhealth, fairness en bronblokkades |
| 2 | Q2, F2, G2, R2, N2 | duurzame ingest, herstel en enrichment; N2 is CTP-626 |
| 3 | U3, C3, M3, J3, L3a–L3f | search/chat en expliciete broncohorts |
| 4 | CTP-458, D4, O4 | actor/scope, correctie, verwijdering en disaster recovery |
| 5 | CTP-459, K5 | exportvertical en capaciteitsoordeel |
| 6 | CTP-460, Z5, T6 | feedback/replay, volledige JI-coverage en gecontroleerde Trigger-exit |

`Z5` is **CTP-633**: sluit de Effect-dekking voor alle actieve JI-flows en
bronnen, inclusief enrichment (CTP-626), search/chat, providercohorten,
feedback, correctie en restore. `T6` is **CTP-635**: schakel Trigger pas uit
na Z5, CTP-626, CTP-612 en A0, met per flow één actieve uitvoerder,
crash/replay-bewijs en een werkend rollbackpad. Deze crosswalk dupliceert geen
issues en activeert geen wave.

### Freshness, reconciliation en RPO/RTO

| Maatstaf | A0-besluit | Bewijsstatus |
| --- | --- | --- |
| Discovery-freshness | **Voorgestelde target: 15 minuten** voor een geaccepteerde JI-broncohort. Geen bestaande productgarantie en niet automatisch geldig voor CI. | Niet gemeten in A0; bronritme, blokkades en workload moeten per cohort worden vastgesteld. |
| Zichtbaarheid | **Voorgestelde target: p95 5 minuten** van gecommitteerde canonieke mutatie tot leesbaar searchresultaat. Geen claim over huidige latency. | E0/K5 en latere homogene cohorts nodig; p95 met onvoldoende n blijft indicatief. |
| Reconciliation | Verplicht per bron/provider. De bron bepaalt sleutel, ordering, cadence, minimale payload en terminale onbekende-uitkomstprocedure. | Contractueel voorgesteld; concrete provider- en bronflows blijven open tot hun slices bewijs leveren. |
| RPO | Geen numerieke waarde aangenomen. Minimumbeleid is dat canonieke mutaties alleen als hersteld gelden wanneer raw/receipt/DB-bewijs de laatste geaccepteerde grens ondersteunt. | Product- en operations-owner moeten een waarde en meetprocedure accepteren. |
| RTO | Geen numerieke waarde aangenomen. Minimumbeleid is herstel van één complete JI-verticale keten tot zichtbaar resultaat zonder stille duplicatie of resurrectie. | CTP-632/633 leveren restore- en replaybewijs; lokale gates zijn hiervoor onvoldoende. |

Deze waarden zijn besluit- en readiness-input, geen gemeten SLO's. Productie- of
Candidate-acceptatie mag ze pas als garantie publiceren nadat de bevoegde owners
de cohort, meetmethode, reconciliation en restore-evidence hebben geaccepteerd.

## Linear-slice index

| Slice | Issue | Onderwerp |
| --- | --- | --- |
| 0 | CTP-454 | Baseline ADR-0013 + evidence |
| ADR+kaart | CTP-456 | Dit document + ADR-0014 |
| 1 | CTP-455 | Runtime + JSON-LD/Spott reads |
| 2 | CTP-467 | Resterende connector reads |
| 3 | CTP-468 | Application Effects |
| 4 | CTP-469 | Registry Effect Schema SoT |
| 5 | CTP-470 | Domain schemas |
| 6 | CTP-471 | Env SoT |
| 7 | CTP-472 | Search client |
| 8 | CTP-473 | DB store wrappers |
| 9 | CTP-474 | Server/API boundary |
| 10 | CTP-476 | Worker task bodies |
| 11 | CTP-475 | Web serialisable contracts |
| 12 | CTP-478 | Performance align |
| 13 | CTP-477 | Scoped Effect lint |
| 14 | CTP-479 | Production enablement |


## Schema-transitie (kort)

| Fase | Canonieke SoT | Zod-rol | Afgeleiden |
| --- | --- | --- | --- |
| Nu (pre-CTP-455) | feitelijk Zod in registry/env/connectors | hand-maintained | — |
| Per gemigreerde module | Effect Schema | verwijderen of alleen als **gegenereerde**/adapter-output | Standard Schema / JSON Schema / TS types voor web/tRPC/MCP |
| Verboden | — | parallel hand-maintained Zod **én** Effect Schema voor zelfde contract | — |

## Slicevolgorde

Slices zijn strikt geordend op leerrendement en dependency-richting. Elke slice is een apart Linear-implementatie-issue (of bestaand issue) met eigen PR, testbewijs en rollback.

### Slice 0 — Baseline (DONE-ish)

| Veld | Waarde |
| --- | --- |
| Issue | CTP-454 (#190 ADR/harness, #191 live native evidence) |
| Scope | Meetprocedure, fault/retry-tabel, harness, native warm/cold fixtures |
| Ownership | `docs/adr/ADR-0013-*`, `docs/effectts/*`, `docs/evidence/ctp-454/`, `scripts/effect-baseline/**` |
| Deps | geen Effect first-party pin |
| AC | ADR-0013 + evidence README + reviewrubric |
| Testbewijs | harness dry-run + measure cold/warm artifacts |
| Rollback | n.v.t. (docs/evidence); harness isolatie |
| Prod | OFF |

### Slice 1 — Gedeelde Effect-runtime + JSON-LD/Spott read-I/O (**volgende**)

| Veld | Waarde |
| --- | --- |
| Issue | **CTP-455** (bestaand; start ná merge van CTP-456) |
| Scope | First-party `effect` pin; gedeelde Runtime/Layer-helpers; JSON-LD listing/detail + Spott list/get onder wire-contract; dual-path regressie t.o.v. CTP-454 native |
| Ownership | `packages/connectors/src/json-ld/**`, `packages/application/src/export/spott/**` (of huidige Spott read-paden), nieuwe shared Effect helper-module (locatie in CTP-455 kiezen, bijv. `packages/application/src/effect` of `packages/domain`-adjacent — **geen** auth/db-herbouw) |
| Deps | Slice 0; ADR-0014 |
| AC | Zelfde wire-resultaten op fixtures; fault/cancel/cleanup; retry-plafond ≤ ADR-0013; dual-path evidence; flag default off |
| Testbewijs | bestaande connector/export fixtures + effect-baseline dual-path; `bun test` scoped + `check-types` |
| Rollback | flag/module-swap terug naar Promise-adapters; dependency pin revert indien nodig |
| Prod | OFF (aparte release later) |
| Stop | wire-regressie, retry-plafond↑, PII in artifacts |

### Slice 2 — Connector read-adapters (resterende bronnen)

| Veld | Waarde |
| --- | --- |
| Issue | **CTP-467** |
| Scope | `tenderned`, `opdrachtoverheid`, `inhuurdesk`, `needstaffing`, `onefellow`, `striive`, `flinter`, `harveynash`, `ctm`, gedeelde `retry.ts`/`limiter.ts`/`run.ts` naar Effect waar van toepassing |
| Ownership | `packages/connectors/src/**` (excl. al gemigreerde json-ld) |
| Deps | Slice 1 (gedeelde runtime + bewezen wire-contract) |
| AC | per-bron fixtures groen; DEC-008 minimisatie intact; known-hash/lifecycle ongewijzigd |
| Testbewijs | per-connector specs + poll-bron sandbox |
| Rollback | per-bron flag of file-level revert |
| Prod | OFF tot bron-specifieke release |
| Status (CTP-467) | Opt-in create*EffectClient per bron landed; native factories remain default; shared retry/limiter/run unchanged (Effect uses @ji/connectors/effect-runtime) |

### Slice 3 — Application use-cases (excl. capability schema cutover)

| Veld | Waarde |
| --- | --- |
| Issue | **CTP-468** |
| Scope | `packages/application/src/{ingest,normalise,lifecycle,bronnen,sources,observability}/**` naar Effect programs |
| Ownership | `@ji/application` |
| Deps | Slice 1; bij voorkeur Slice 2 voor connector-Effect types |
| AC | use-case parity op unit/integration fixtures; geen DB-schemawijziging |
| Testbewijs | application specs |
| Rollback | module-swap per use-case map |
| Status (CTP-468) | Opt-in Effect programs landed for ingest/normalise/lifecycle/bronnen/sources/observability; native default; prod OFF; no DB schema |

### Slice 4 — Capability registry schemas → Effect Schema SoT

| Veld | Waarde |
| --- | --- |
| Issue | **CTP-469** |
| Scope | `packages/application/src/registry/schemas.ts` e.r.; handlers blijven gedragseigenaar; transports consumeren afgeleide Standard Schema waar nodig (KTD4) |
| Ownership | registry maintainers (`schemas.ts`, `capability.ts`, `capabilities.ts`, handlers) |
| Deps | Slice 1 (Effect pin); bij voorkeur domain Schema helpers |
| AC | één SoT; geen handmatige Zod-duplicaten; MCP+REST drift-gates groen; wire backwards-compatible |
| Testbewijs | `check:capability-registry`, `check:capability-coverage`, registry specs |
| Rollback | behoud vorige gegenereerde/Zod snapshots tot cutover-commit revert |
| Stop | parallel hand-maintained Zod+Effect voor zelfde tool I/O |
| Status (CTP-469) | Effect Schema SoT landed voor registry-contracten (`schemas.ts`, `capability.ts`, `capabilities.ts`, handler I/O, sourcing-assessment); registry-validatie, Standard Schema en MCP/REST JSON Schema zijn afgeleid via `registry/schema-helpers.ts`; geen Zod-duplicaten meer voor tool I/O; descriptors semantisch identiek aan de vorige Zod-output; prod Effect runtime OFF; Motian ongewijzigd |

### Slice 5 — Domain Effect Schema

| Veld | Waarde |
| --- | --- |
| Issue | **CTP-470** |
| Scope | `packages/domain/**` publieke modellen (`aanvraag`, ids, lifecycle) als Effect Schema; pure parsers mogen Effect-vrij |
| Ownership | `@ji/domain` |
| Deps | Slice 4 of parallel ná gedeelde Schema-conventies uit Slice 1 |
| AC | domain exporteert SoT; application/connectors importeren types uit domain |
| Testbewijs | domain specs + typecheck |
| Rollback | git revert domain schema module |
| Status (CTP-470) | Effect Schema SoT landed voor publieke domain-modellen (`aanvraag`, ids/statussen, lifecycle, bron-config, money); types afgeleid van Schema; Boolean parser + pure validators/transitions Effect-vrij; registry importeert `AanvraagLifecycleSchema` i.p.v. gedupliceerde literals; prod Effect runtime OFF; Motian ongewijzigd |

### Slice 6 — Env parsing

| Veld | Waarde |
| --- | --- |
| Issue | **CTP-471** |
| Scope | `packages/env/**` (`server.ts`, `web.ts`, `database.ts`, `projector*.ts`) |
| Ownership | `@ji/env` |
| Deps | Effect Schema pin (Slice 1+) |
| AC | boot-time fail-fast parity; geen secrets in errors |
| Testbewijs | env specs |
| Rollback | revert env package |

### Slice 7 — Search client I/O

| Veld | Waarde |
| --- | --- |
| Issue | **CTP-472** |
| Scope | `packages/search/**` HTTP/JSON clientpaden |
| Ownership | `@ji/search` |
| Deps | Slice 1; ADR-0007/0009 ongemoeid (indexarchitectuur) |
| AC | projector/search fixtures; schema-hash invarianten intact |
| Testbewijs | search specs |
| Rollback | client module swap |
| Status (CTP-472) | Opt-in `FetchManticoreEffectClient` + describe Effect helpers landed; native `FetchManticoreClient` / `fromUrl` remain default; prod OFF; Motian ongewijzigd; ADR-0007/0009 ongemoeid |

### Slice 8 — DB store wrappers (geen migratie-/auth-herbouw)

| Veld | Waarde |
| --- | --- |
| Issue | **CTP-473** |
| Scope | Effect wrappers rond bestaande Drizzle stores (`packages/db/src/*stores*`, readers); **geen** herschrijven van `schema/`, migrations, roles, neon-roles |
| Ownership | `@ji/db` application-facing API |
| Deps | Slice 3 |
| AC | SQL-gedrag identiek; layering gate groen |
| Testbewijs | db specs / read-path tests |
| Rollback | wrapper bypass |
| Stop | elke PR die authz, leases, outbox-semantics of migraties “meeneemt” |
| Status (CTP-473) | Opt-in `wrap*StoreEffect` helpers + representative `*Effect` helpers landed voor `QuerySnapshotStore`, `AanvraagStore`, `RawPayloadStore`, `ScrapeRunReader`, `BronHealthStore`, `AlertStore`, `SavedSearchStore`, `MissedPollsStore`, `KnownHashStore`, `SearchVersionStore`; native `Postgres*Store`/readers blijven default; prod Effect runtime OFF; Motian/outbox/leases/migraties ongemoeid |

### Slice 9 — Server/API boundary

| Veld | Waarde |
| --- | --- |
| Issue | **CTP-474** |
| Scope | `apps/server/**`, `packages/api/**`: Runtime per request; map Effect faults → HTTP/MCP errors; **ADR-0012 auth blijft** |
| Ownership | server + api packages |
| Deps | Slices 3–5 |
| AC | transport-auth specs groen; origin/bearer regels intact |
| Testbewijs | mcp/rest/transport specs + `check-types` |
| Rollback | boundary helper revert |
| Status (CTP-474) | Opt-in Server/REST/MCP/tRPC Effect run boundary landed (`apps/server/src/effect`, `packages/api/src/effect`); native REST/MCP/tRPC handlers remain default; TransportFault/ApiFault → HTTP/MCP/tRPC mappers; prod Effect runtime OFF; ADR-0012 auth untouched; Motian ongewijzigd |

### Slice 10 — Worker / Trigger task bodies

| Veld | Waarde |
| --- | --- |
| Issue | **CTP-476** |
| Scope | `apps/worker/src/tasks/**`, `poll-bron*.ts`: Effect binnen task; Trigger `maxAttempts` ongewijzigd tenzij eigen ADR |
| Ownership | worker |
| Deps | Slices 1–2, 8 |
| AC | poll/drain/backfill sandbox parity; geen retry-plafond↑ |
| Testbewijs | worker specs |
| Rollback | task body revert; Trigger config untouched |
| Status (CTP-476) | Opt-in worker Effect task-body boundary landed (`apps/worker/src/effect`). Polling en curatie draaien nu via de on-box poller; Trigger `schemaTask` blijft alleen voor `enrich-incomplete`, `schedule-enrich-incomplete`, `drain-outbox` en `backfill-neon-v1`, waarbij `drain-outbox` in `SEARCH_PROJECTOR=onbox` deferreert. Dit is geen target durability-owner voor nieuwe flows. Trigger retry/queue-config blijft ongewijzigd tot per retained flow of cutover eigen Effect-owned crash/replay- en rollbackbewijs bestaat; prod Effect runtime OFF. |

### Slice 11 — Web DTO / client types

| Veld | Waarde |
| --- | --- |
| Issue | **CTP-475** |
| Scope | `apps/web/**` capability clients & features: types/DTO van SoT; **geen** Effect Runtime in browser tenzij expliciet goedgekeurd |
| Ownership | web |
| Deps | Slices 4–5, 9 |
| AC | UI bouwt; layering gate; geen DB imports |
| Testbewijs | web unit/feature specs + `check-layering` |
| Rollback | type-import revert |
| Status (CTP-475) | Web serialisable contracts from SoT landed (`packages/application/src/registry/web-contracts.ts` + `apps/web/.../contracts`); capability-client REST failure envelope, search scope/sort, markering statuses, SearchFilters, versie/markering readback types derived from Effect Schema / `@ji/search`; no Effect Runtime in browser; prod Effect OFF; Motian ongewijzigd |

### Slice 12 — Performance / tracing alignering

| Veld | Waarde |
| --- | --- |
| Issue | **CTP-478** |
| Scope | `packages/performance/**` hooks voor Effect spans; budgets ADR-0001/0003 |
| Ownership | `@ji/performance` |
| Deps | Slice 1+ |
| AC | labels stabiel; geen PII |
| Testbewijs | performance specs |
| Rollback | hook disable |
| Status (CTP-478) | Opt-in `@ji/performance/effect` critical-path Effect span hooks landed (`withCriticalPathSpan`, sanitized attributes, `PERF_EFFECT_SPANS` default OFF); native critical-path sessions remain default; labels stay ADR-0001 set; no PII in spans/labels; Effect module is a separate export (no browser/Node bleed, #203); Motian ongewijzigd; prod Effect OFF until CTP-479 per-surface flip |

### Slice 13 — Scoped lintregels

| Veld | Waarde |
| --- | --- |
| Issue | **CTP-477** |
| Scope | enable Effect rules **alleen** in packages met directe `effect` dependency |
| Ownership | `tools/oxlint/**`, AGENTS.md |
| Deps | Slice 1 (first-party pin) |
| AC | lint groen; geen false positives in non-Effect packages |
| Testbewijs | `ultracite check` / CI lint |
| Rollback | rule flag off |
| Status (CTP-477) | Scoped `anti-slop-effect` oxlint rules enabled only in packages/apps with a direct `effect` dependency (`apps/server`, `apps/worker`, `packages/{api,application,connectors,db,domain,env,search}`); non-Effect packages untouched; Motian ongewijzigd; prod Effect OFF until CTP-479 per-surface flip |

### Slice 14 — Gecontroleerde productieactivatie (geen auto)

| Veld | Waarde |
| --- | --- |
| Issue | **CTP-479** (per-surface follow-ups allowed) |
| Scope | feature flags on, canary, evidence pack, rollback drill |
| Ownership | platform + on-call surface owner |
| Deps | relevante implementatieslices + ≥20 homogene cohorten waar latency-gate speelt (ADR-0003) |
| AC | release checklist; prod evidence; rollback oefening |
| Testbewijs | release bewijsbundle (niet alleen CI) |
| Rollback | flag off within RTO |
| Stop | activeren “omdat CTP-453 subissues Done zijn” zonder deze slice |
| Status (CTP-479) | Per-surface flags + canary hooks landed (`JI_EFFECT_SEARCH|DB|SERVER|WORKER`, `PERF_EFFECT_SPANS` / `JI_EFFECT_PERF`); defaults OFF; `@ji/env/effect-flags` SoT; runbook `docs/runbooks/effectts-production-enablement.md`; **prod flips + live evidence = Catapulze**; Motian ongewijzigd |

## Dependencygrafiek (samenvatting)

```text
CTP-454 (baseline) ──► CTP-456 (dit ADR + kaart) ──► CTP-455 (runtime + JSON-LD/Spott)
                                                      ├─► Slice 2 connectors
                                                      ├─► Slice 3 application
                                                      ├─► Slice 4 registry schemas ◄─► Slice 5 domain
                                                      ├─► Slice 6 env
                                                      ├─► Slice 7 search
                                                      └─► Slice 8 db wrappers
                                                             └─► Slice 9 server/api ─► Slice 11 web
                                                             └─► Slice 10 worker
                                                      Slice 12 performance CTP-478 (parallel na 1)
                                                      Slice 13 lint CTP-477 (na pin)
                                                      Slice 14 prod enablement CTP-479 (laatste, per surface)
```

## Package-dekking checklist

| Package/app | Slice(s) | Notitie |
| --- | --- | --- |
| domain | 5 | Schema SoT |
| application | 1,3,4 | Spott + use-cases + registry |
| connectors | 1,2 | JSON-LD first |
| search | 7 | |
| performance | 12 | |
| db | 8 | wrappers only |
| auth | — (interop) | Better Auth behouden; geen eigen slice tenzij boundary-hulp |
| env | 6 | |
| api | 9 | |
| ui / config | — | behoud; types via SoT indien nodig |
| server | 9 | |
| worker | 10, H1/S1, Q2/N2/R2, CTP-626/633/635 | On-box poller is actuele polling/curation-executor; vier benoemde Trigger-jobs blijven retained interop |
| source registry/connectors | 1–2, J3/L3a–L3f, CTP-633 | Iedere broncohort en provider/readiness-pad vereist eigen bewijs; bestaande Promise-clients zijn geen Effect-PASS |
| web | 11 | serialisable only |

## Wat deze kaart niet doet

- Geen claim dat CTP-453 of CTP-455 Done is.
- Geen Motian/andere repo-wijzigingen.
- Geen productieflags aan.
- Geen autorisatie-/database-/export-commit herbouw in I/O-slices.
