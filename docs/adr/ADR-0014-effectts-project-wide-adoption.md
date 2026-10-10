# ADR-0014 — Projectbrede EffectTS-adoptie, Effect Schema-eigenaarschap en fasering

- Status: Accepted; gedeeltelijk superseded voor durability en platformruntime door CTP-617/A0
- Datum: 2026-09-19 (oorspronkelijk besluit 2026-09-07)
- Eigenaar: Job Intelligence platform
- Issues: CTP-617 (parent CTP-613); CTP-456 (parent CTP-453); baseline CTP-454 / [ADR-0013](ADR-0013-effectts-platform-baseline.md); volgende implementatieslices CTP-455+
- Zie ook: [migratiekaart](../effectts/migration-map.md), [JSON-LD/Spott wire-contract](../effectts/json-ld-spott-wire-contract.md), [platform-integratie-inventaris](../platform-integration-inventory.md), [ADR-0001](ADR-0001-performance-evidence-contract.md), [ADR-0003](ADR-0003-performance-budgets-and-regression-policy.md)

## Context

Op **5 september 2026** heeft Ryan EffectTS gekozen voor het complete Catapulze-project. Nieuwe first-party TypeScript volgt die richting; bestaande Promise/Zod-code migreert gefaseerd. Metingen bepalen veilige migratie en regressiegrenzen; ze heropenen de adoptiekeuze **niet**.

CTP-454 legde de meet- en foutsemantiekbaseline vast ([ADR-0013](ADR-0013-effectts-platform-baseline.md)) met native warm/cold fixture-evidence onder [`docs/evidence/ctp-454/`](../evidence/ctp-454/). De verwijzing naar `origin/main` @ `117bfe81` is een historische snapshot van 7 september 2026: daarin was `effect` nog **geen** first-party dependency (alleen transitief via Prisma). De actuele A0-status en overgang staan in de migratiekaart; dit ADR registreert het projectbrede besluit, frameworkgrenzen, Effect Schema-eigenaarschap en de fasering. De uitvoerbare slicekaart staat in [`docs/effectts/migration-map.md`](../effectts/migration-map.md).

Dit issue/PR levert besluit + plan. Het claimt **niet** dat de migratie is uitgevoerd, claimt **niet** CTP-453 Done, en activeert **geen** productie.

## CTP-617/A0 — traceerbare supersession

Dit ADR blijft leidend voor projectbrede Effect Schema-eigenaarschap, smalle
frameworkgrenzen en gefaseerde migratie. CTP-617 supersedeert alleen de eerdere
keuze dat Trigger.dev de doel-eigenaar van duurzame task execution blijft. Die
keuze staat hieronder als historische transitiefase geregistreerd; nieuwe
first-party backend-I/O en nieuwe jobs mogen geen nieuwe Trigger-durability
afhankelijkheid introduceren.

| Eerdere richting | Status na A0 | Traceerbare grens |
| --- | --- | --- |
| Trigger.dev als doel-eigenaar van duurzame task execution | **Superseded als doelarchitectuur** | Effect-owned Services/Layers en een nog per flow te kiezen duurzame Effect-runtime; de bestaande Trigger-adapter blijft alleen voor retained flows actief. T6 (CTP-635) mag pas na Z5 en eigen crash/replay-bewijs uitschakelen. |
| Python FastAPI + Pydantic als JI-runtime | **Superseded voor JI** | De historische doelplaat wordt vervangen door Bun/TypeScript/Effect/Drizzle. De intentie rond capabilities, provenance en system of record blijft behouden. |
| Python/LangGraph als first-party agentruntime | **Niet aangenomen en superseded voor JI** | Agents gebruiken dezelfde server-geautoriseerde capability- en actioncontracten. Er komt geen parallel first-party LangGraph-runtime in deze migratielijn. |
| Temporal of een andere algemene orchestrator | **Niet gekozen** | Alleen heropenen na gemeten noodzaak, een expliciet ADR en passend crash/replay-bewijs. |

Deze tabel wijzigt geen productie- of providerrechten. De historische bronnen
blijven leesbaar als onderzoekscontext; hun uitvoeringskeuze is niet langer een
startvoorwaarde voor nieuwe JI-slices.

### Geordende waves en actuele executor

De geordende uitvoeringscrosswalk staat in de [migratiekaart](../effectts/migration-map.md#bestaande-wave-crosswalk-en-t6z5-definitie)
en volgt het [CTP-613-programma](https://linear.app/rcjt-studio/issue/CTP-613/effect-platformwaves-ji-afronden-trigger-verlaten-en-candidate)
en het [uitvoeringscontract](https://linear.app/rcjt-studio/document/effect-platformwaves-uitvoeringsplan-en-crabbox-contract-04922c890b87).
De actuele regel is één actieve executor per flow: polling en curatie zijn al
on-box; `enrich-incomplete`, `schedule-enrich-incomplete`, `drain-outbox` en
`backfill-neon-v1` zijn retained Trigger-paden. De `drain-outbox`-wrapper
deferreert wanneer de on-box projector actief is.

`Z5` betekent CTP-633: volledige Effect-coverage voor actieve JI-flows en
bronnen, inclusief CTP-626 enrichment, providercohorten, search/chat,
feedback, correctie en restore. `T6` betekent CTP-635: Trigger uitschakelen
pas na Z5, CTP-626, CTP-612 en A0, met per flow één actieve executor,
crash/replay-bewijs en rollbackpad. Dit zijn bestaande programmastappen, geen
nieuwe issues of automatische activatie.

## Relatie tot eerdere ontwerpkeuzes (bevestiging / beperking / supersession)

| Bron | Oorspronkelijke keuze | Stand na dit ADR |
| --- | --- | --- |
| [Techstack-brainstorm 27-08-2026](../brainstorms/2026-08-27-techstack-brainstorm.md) | Bun + TypeScript + Effect-TS + Drizzle + Effect Schema | **Bevestigd** als projectbrede richting (besluit 2026-09-05) |
| Slice A plan [KTD1](../plans/2026-08-27-2022-feat-slice-a-read-path-plan.md) | Monorepo, Effect layers, geen UI→DB; Bun + Effect-TS + Effect Schema + Drizzle | **Bevestigd**; huidige checkout is Promise/Zod — migratie is gefaseerd, geen big-bang |
| Slice A plan [KTD4](../plans/2026-08-27-2022-feat-slice-a-read-path-plan.md) | Één capability registry; Effect Schema SoT; MCP Standard Schema via adapter; **geen** parallel Zod-domeinmodel | **Bevestigd** als schema-eigenaarschapsregel; huidige Zod in registry/env is transitie, geen tweede canonieke SoT |
| Doelarchitectuur 25-08-2026 (Claude artifact) / Python FastAPI + Pydantic | Historische doelplaat | **Superseded** voor JI-runtime door 27-08 stack + dit ADR (KTD1); intentie (capability, provenance, SoR) blijft |
| Huidige main (Promise + Zod + expliciete DI) | Werkende implementatie | **Beperkt behouden** tot de betreffende slice gemigreerd is; geen stilzwijgende uitbreiding van Zod als canonieke SoT |
| [ADR-0013](ADR-0013-effectts-platform-baseline.md) | Baseline, fault/retry, meetcohorten | **Ongewijzigd leidend** voor regressiebewijs; dit ADR bouwt erop voort |

## Besluit

### 1. Projectbrede EffectTS-adoptie

- **Eigen TypeScript** (domain, application, connectors, search, performance, API/server handlers, worker-task *logica*, gedeelde libs): Effect als primaire runtime voor nieuwe code en voor gemigreerde slices.
- **Framework-/SDK-/wiregrenzen**: Effect stopt waar een framework of SDK de lifecycle of serialisatie al bezit. Duurzame uitvoering is een expliciete first-party Effect-grens; tijdelijke interop-adapters mogen blijven totdat de flow is gemigreerd. Zie de inventaris hieronder.
- **Trigger.dev** is alleen een tijdelijke interop-adapter voor retained taken. Polling en curatie zijn al naar de on-box poller verplaatst; `enrich-incomplete`, `schedule-enrich-incomplete`, `drain-outbox` en `backfill-neon-v1` blijven expliciet benoemde Trigger-paden totdat hun eigen cutoverbewijs bestaat. Nieuwe first-party backend-I/O en joblogica lopen via Effect Services/Layers en een per flow gekozen duurzame Effect-runtime. Een gewone duurzame job gebruikt de eenvoudigste bewezen persistente queue; Workflow/DurableQueue is alleen toegestaan wanneer de werkelijke workflow dat nodig maakt. Request-retry blijft adapter-eigenaar per ADR-0013.
- **Geen** herbouw van autorisatie, database-SoR, outbox/leases, provider-idempotentie of export-commitpaden in dezelfde refactor als een Effect-I/O-slice.
- **Geen automatische productieactivatie** door afronden van ADR, baseline of eerste adapters. Productie-aan zet alleen via een aparte gecontroleerde implementatie/release met eigen bewijs.

### 2. Frameworkgrenzen per package/app

| Pad | Rol | Effect-toepassing | Interop / gemotiveerd behoud |
| --- | --- | --- | --- |
| `packages/domain` | IDs, Boolean AST, lifecycle, domeinmodellen | **Toepassen**: Effect Schema als canonieke publieke schemas; pure functies mogen Effect-vrij blijven | Geen I/O; geen DB-imports |
| `packages/application` | Use-cases, registry, export/Spott, normalisatie | **Toepassen**: Effect programs + Layers voor use-cases; schemas via domain/SoT | Capability handler-API blijft transport-agnostisch |
| `packages/connectors` | Bronadapters, retry/limiter, object-store | **Toepassen**: read/write I/O als Effect; eerste slice JSON-LD (CTP-455) | HTTP/fetch achter Effect; fixture-harness behouden |
| `packages/search` | Manticore client, cache | **Toepassen** (na I/O-slices): clientcalls als Effect | Manticore wire JSON blijft; index-eigenaarschap ongewijzigd |
| `packages/performance` | Critical-path labels, digests | **Interop**: Effect tracing hooks waar Effect draait; bestaande labels blijven | Geen verplichte herschrijving van pure helpers |
| `packages/db` | Drizzle schema, stores, migraties | **Interop / behoud**: Drizzle + SQL blijven SoR-toegang; Effect mag stores wrappen | **Geen** Effect-herbouw van migraties/rollen in I/O-slices |
| `packages/auth` | Better Auth, security-config | **Gemotiveerd behoud**: Better Auth lifecycle | Effect alleen aan randen (session→actor mapping), geen auth-rewrite |
| `packages/env` | Typed env (nu Zod) | **Toepassen** later: Effect Schema of afgeleide parse; boot-time validatie | Process env blijft stringly; één SoT-schema |
| `packages/api` | tRPC routers | **Interop**: procedures roepen application Effects aan; tRPC input/output via afgeleide schemas indien nodig | Geen parallel handmatig Zod-model |
| `packages/ui` / `packages/config` | UI-primitives, TS-config | **Gemotiveerd behoud** (pure/config) | Geen Effect-runtime in UI-primitives tenzij gedeelde schema-types |
| `apps/server` | Hono + REST/MCP/tRPC transports | **Interop**: transport blijft Hono/Better Auth; handlers `runPromise`/`Runtime` aan boundary | Authz/origin/MCP-session per ADR-0012 ongemoeid in I/O-slices |
| `apps/worker` | On-box poller voor polling/curatie; retained Trigger tasks voor enrichment, drain en backfill | **Interop tijdens migratie**: de actuele executor wordt per flow benoemd; first-party job-I/O en nieuwe durability lopen via Effect Services/Layers | Geen nieuwe Trigger-only flow; T6 vereist één actieve uitvoerder, crash/replay-bewijs en rollbackpad |
| `apps/web` | Next.js UI | **Beperkt toepassen**: serialiseerbare DTO/types uit SoT; geen Effect-runtime in RSC tenzij expliciete slice | Geen UI→DB; data via server/API |
| `apps/api` (indien aanwezig/legacy pad) | HTTP+MCP volgens KTD1 | Zelfde als server-boundary | Align met capability registry |

### 3. Schema-eigenaarschap (één bron van waarheid)

1. **Canonieke publieke schemas** (domein + capability I/O + gedeelde API-contracten) hebben **één** hand-onderhouden bron: **Effect Schema**.
2. **Verboden**: twee handmatig parallel onderhouden canonieke modellen (Zod én Effect Schema voor dezelfde entiteit/contractversie).
3. **Toegestaan tijdens transitie**:
   - Zod blijft in nog niet-gemigreerde modules tot die slice klaar is;
   - afgeleide adapters (bijv. Standard Schema / Zod-compat / JSON Schema) gegenereerd of mechanisch afgeleid van Effect Schema waar framework/SDK dat eist (MCP KTD4, tRPC, frontend form libs);
   - Drizzle-tabelschma's blijven SQL/Drizzle-eigenaarschap (persistentiemodel ≠ publiek wire-schema); mappinglaag expliciet.
4. **Frontend**: web consumeert **serialiseerbare** DTO's / gedeelde types afgeleid van de SoT; browserbundles slepen geen server Layers of secrets mee.
5. **API-wire**: REST/MCP/tRPC-contractversies blijven backwards-compatible per slice; breaking schemawijziging = eigen issue + version bump, niet stille Effect-migratie.

### 4. Eerste operationele grens en runtimecontract

- **Eerste operationele grens**: JSON-LD listing/detail + Spott REST list/get onder één begrensd uitvoeringscontract (**CTP-455**), wired zoals [`docs/effectts/json-ld-spott-wire-contract.md`](../effectts/json-ld-spott-wire-contract.md) en fault/retry-tabel in ADR-0013.
- **Runtime / Layer lifetime**: per request (server) of per job-invocatie (worker) een begrensde Runtime; geen process-globale mutable Layer-state voor request-scoped deps (HTTP clients, abort, credentials handles). Shared immutable Layers (clock, config stubs) mogen. Een Effect-fiber is nooit op zichzelf een durable checkpoint.
- **Tracing**: critical-path labels via `@ji/performance` waar het pad al instrumenteert; Effect spans/annotations alignen, geen PII in spans/artifacts.
- **Foutmapping**: ADR-0013-categorieën (`auth`, `validation`, `not_found`, `rate_limit`, `transient_network`, `server_5xx`, `cancel`) aan de adaptergrens; geen lekken van ruwe provider-internals naar capability clients.
- **Cancellation**: `AbortSignal` / Effect interrupt doorgeven tot fetch/timers; cleanup verplicht (ADR-0013).
- **Rollout / rollback**: feature-flag of module-swap per slice; default **uit** in productie tot aparte release. Rollback = vorige adapterimplementatie + flag off; geen data-migratie vereist voor pure read-I/O-slices. Voor durable jobs is rollback alleen geldig wanneer de bestaande receipt-, queue- of outboxstatus opnieuw door de vorige eigenaar kan worden hervat.
- **Stopcriteria** (slice mag niet mergen / niet aanzetten): wire-contract regressie; retry-plafondstijging zonder ADR; fixture incorrectness; PII in artifacts; productieflag aan zonder release-bewijs.

Fasering is gemotiveerd door: (1) twee representatieve adapters hergebruik bewijzen, (2) onboarding van volgende connectors goedkoper maken, (3) onderhoud van één fout/retry/cancel-model, (4) platformgroei zonder Zod/Effect-dualiteit en (5) Trigger gecontroleerd verlaten zonder een tweede first-party runtime naast Effect te introduceren.

### 5. Docs en lint

- Docs in `docs/adr/` + `docs/effectts/` volgen dit besluit; Linear is readback.
- Effect-specifieke lint/anti-slop-regels gaan **alleen** aan in packages die `effect` direct gebruiken (AGENTS.md); globaal aanzetten vóór first-party pin is verboden.
- Regressiebewijs-pointers: ADR-0013 + [`docs/evidence/ctp-454/`](../evidence/ctp-454/).

## Gevolgen

- CTP-455 implementeert de eerste Effect-runtime + JSON-LD/Spott-migratie tegen dit ADR en ADR-0013; dual-path meting volgt daar.
- Latere slices volgen [`migration-map.md`](../effectts/migration-map.md); uitstel van een slice wijzigt de projectbrede richting niet.
- Nieuwe publieke schemas worden in Effect Schema geschreven; Zod-only nieuwe canonieke modellen zijn afgewezen.
- JI en Candidate Intelligence zijn zelfstandig toegankelijke apps/modules. Een Candidate-only gebruiker hoeft JI niet te openen. Een platformlaag mag beide tonen, maar dit besluit maakt geen keuze voor één deployment, impliciete multitenancy of een gedeelde module-database.
- Motian en overige productrepos buiten deze JI-repo blijven buiten scope.

## Verificatie

- Onafhankelijke ADR-review tegen ADR-0013-baseline en (na CTP-455) beide implementaties.
- Controle dat migratiekaart alle packages/apps dekt met ownership, deps, AC, testbewijs en rollback.
- Controle dat de actuele on-box poller, retained Trigger-paden, provider-/broncohorten (waaronder Mercell, Indeed, LinkedIn Jobs en Werk.nl) en enrichment/backfill afzonderlijk zijn geregistreerd en niet als Effect-PASS worden gelezen.
- Controle dat Z5/CTP-633 en T6/CTP-635 via de bestaande wave-crosswalk zijn gedefinieerd met één actieve executor, replay- en rollbackbewijs.
- Controle dat de flowregistratie ingest, search, chat, export, feedback, herstel en toekomstige providers dekt en per flow runtime, owner, flag, status en bewijs noemt.
- Controle dat 15 minuten discovery-freshness en 5 minuten p95 zichtbaarheid als voorgestelde acceptance targets zijn gelabeld en dat bronreconciliatie plus RPO/RTO niet als bestaande garanties worden gepresenteerd.
- Geen productieactivatie in deze PR; geen CTP-455-runtimecode in deze PR.

## Referenties

- [ADR-0013 — EffectTS platformbaseline](ADR-0013-effectts-platform-baseline.md)
- [CTP-456](https://linear.app/rcjt-studio/issue/CTP-456/effectts-adr-leg-projectbrede-architectuur-schema-eigenaarschap-en)
- [CTP-453](https://linear.app/rcjt-studio/issue/CTP-453/effectts-realiseer-de-basis-voor-projectbrede-gefaseerde-migratie)
- [CTP-454](https://linear.app/rcjt-studio/issue/CTP-454/effectts-leg-platformbaseline-foutsemantiek-en-meetcriteria-vooraf)
- [CTP-455](https://linear.app/rcjt-studio/issue/CTP-455/effectts-migreer-json-ld-en-spott-read-io-naar-de-gedeelde-runtime)
