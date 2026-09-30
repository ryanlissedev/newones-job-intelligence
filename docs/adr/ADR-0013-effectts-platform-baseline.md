# ADR-0013 — EffectTS platformbaseline, foutsemantiek en meetcriteria

- Status: Proposed
- Datum: 2026-09-07
- Eigenaar: Job Intelligence platform
- Issues: CTP-454 (parent CTP-453); gerelateerd CTP-455
- Zie ook: [ADR-0001](ADR-0001-performance-evidence-contract.md), [ADR-0003](ADR-0003-performance-budgets-and-regression-policy.md), [platform-integratie-inventaris](../platform-integration-inventory.md), [JSON-LD/Spott wire-contract](../effectts/json-ld-spott-wire-contract.md)

## Context

Op 5 september 2026 is EffectTS gekozen als richting voor nieuwe en gefaseerd te migreren TypeScript-code in Catapulze. Metingen bepalen veilige migratie en regressiegrenzen; ze heropenen de adoptiekeuze niet. Op peildatum `origin/main` @ `189ea0d4e48230b7cb3ebedbcc86db2a950f9266` is `effect` **geen** first-party dependency: de lockfile bevat alleen een transitieve `effect@3.21.0` via `@prisma/config`. JSON-LD listing/detail (`packages/connectors/src/json-ld`) en Spott REST list/get (`packages/application/src/export/spott`) zijn de representatieve read-adapters voor de eerste vergelijking (CTP-455).

Zonder vastgepinde toolchain, foutsemantiek, retry-eigenaarschap en meetprocedure kunnen oude timings of hetergene cohorts als “baseline” worden misbruikt. Dit ADR legt die vooraf vast. Live cohortmetingen horen bij CTP-454: native warm/cold evidence staat onder `docs/evidence/ctp-454/`; Effect-vergelijking volgt na first-party pin (CTP-455). Productieactivatie blijft uit.

## Besluit

### 1. Toolchain- en SDK-pins (peildatum main)

| Component | Declared / catalog | Lock resolved (main) | Compatibiliteitsnotitie |
| --- | --- | --- | --- |
| Bun (packageManager) | `bun@1.3.14` in root `package.json` | n.v.t. (manager-pin) | Officiële Bun-docs: TypeScript native; Effect Bun-platform vereist Bun ≥ 1.0 |
| Bun (testhost `catapulze`) | host runtime | `1.4.0` (`~/.bun/bin/bun`) | Host ≠ packageManager-pin; cohort fingerprint moet **beide** vastleggen |
| TypeScript | catalog `^6.0.3` | `typescript@6.0.3` | Projectcompiler voor typecheck-budget |
| `@types/bun` | catalog `^1.3.14` | `@types/bun@1.4.0` | Types volgen host-lijn 1.4.x in lock |
| Effect (first-party) | **niet gedeclareerd** | transitief `effect@3.21.0` via Prisma | Geen activatie in productruntime in deze PR |
| Effect (richting) | n.v.t. | n.v.t. | Officiële Effect v4 RC (augustus 2026): `bun add effect@rc`; ecosystem packages delen één versie; Bun-platform docs vereisen Effect ≥ 4 voor `@effect/platform-bun` |
| Spott “SDK” | hand-rolled REST client | fixtures `fixtures/export/spott/` | Geen npm-SDK; contract = OpenAPI + repo-client |
| JSON-LD “SDK” | hand-rolled HTML/sitemap client | fixtures `fixtures/connectors/{bluetrail,hero,pro-act}/` | Geen npm-SDK; JobPosting-extractie in-repo |

Bronnen (officieel / verifieerbaar):

- Effect v4 RC (31 aug 2026): <https://effect.website/blog/effect-v4-rc-august-recap> — install `bun add effect@rc`
- Effect site: <https://effect.website/>
- Effect v3→v4 migratie: <https://github.com/Effect-TS/effect/blob/main/MIGRATION.md>
- Spott API overview: <https://docs.spott.io/docs/developers/api-overview>
- Spott OpenAPI: <https://docs.spott.io/api-reference/openapi.json>

**Verbod:** bestaande performance-artifacts, Manticore-rapporten of CI-timings uit andere cohorts mogen **niet** als actuele Effect-migratiebaseline worden hergebruikt. Iedere baseline-run moet head SHA, dirty/clean, host fingerprint, cache warm/cold en workload opnieuw vastleggen (ADR-0001).

### 2. Meetprocedure (ADR-0001 / ADR-0003)

| Veld | Waarde voor CTP-454 baseline |
| --- | --- |
| Testhost | `catapulze` (exe.dev VM `<exe-dev-host>`), Linux x86_64, 2 vCPU, ~7.7 GiB RAM |
| Head | volledige 40-hex SHA van de gemeten commit; dirty/clean verplicht |
| Cache cohorts | aparte `cold` en `warm` cohorts; nooit samenvoegen |
| Concurrency | max 2 Bun testworkers; geen watch |
| Output | schema `scripts/effect-baseline/baseline-artifact.schema.json`; vluchtig onder `.artifacts/effect-baseline/` (niet committen) |
| Harness | `bun scripts/effect-baseline/harness.ts --dry-run` (sandbox/fixtures only) |
| Sample policy | runs 1–9 measure-only; ≥10 homogene successen → warn; ≥20 → enforce-kandidaat (ADR-0003) |
| Percentielen | p50/p95 alleen binnen één cohortfingerprint; failures/cancelled/retries apart |

### 3. Foutsemantiek en retry-eigenaarschap

Faultcategorieën voor read-I/O (JSON-LD + Spott list/get):

| Categorie | Voorbeelden | Request-retry (adapter) | Trigger-task-retry | Schrijf-retry |
| --- | --- | --- | --- | --- |
| `auth` | 401/403, ontbrekende/ongeldige `SPOTT_API_KEY` | **nee** | **nee** (fail fast) | n.v.t. op read |
| `validation` | 400/422, onparsebare payload, fixture-mismatch | **nee** | **nee** | n.v.t. |
| `not_found` | 404 | **nee** | **nee** | n.v.t. |
| `rate_limit` | 429 + `Retry-After` indien aanwezig | **ja**, begrensd, respecteer `Retry-After` | alleen als request-budget uitgeput én taaktransient | **verboden blind** |
| `transient_network` | DNS/connect/reset/timeout vóór response | **ja**, begrensd | begrensd; telt mee in totaalbudget | **verboden blind** |
| `server_5xx` | 500/502/503/504 | **ja**, begrensd | begrensd | **verboden blind** |
| `cancel` | `AbortSignal` / deadline | stop; geen verdere attempt | geen “herstel”-retry van geannuleerde read | n.v.t. |

**Totaalbudget (huidige main, peildatum):**

- Request-retry (connector `withRetry`): typisch `maxAttempts: 3`, `initialDelayMs: 250`, `maxDelayMs: 5000`, `multiplier: 2`, full jitter (`apps/worker/src/poll-bron-run.ts`).
- Trigger-task-retry (`poll-bron`): `maxAttempts: 2` (`apps/worker/src/tasks/poll-bron.ts`).
- **Product van attempts** is het worst-case plafond; Effect-migratie mag dit plafond niet stilzwijgend verhogen. Ownership: request-retry = adapter/connector-eigenaar; task-retry = Trigger-task-eigenaar. Reviewers moeten beide kunnen aanwijzen (zie reviewrubric).

**Writes:** geen blinde retries. Spott `POST /vacancies` en andere mutaties vereisen idempotency/reservation (bestaande export-effectpaden); buiten scope van deze read-baseline.

### 4. Functioneel wire-contract (identiek voor JSON-LD én Spott reads)

Zie checklist [`docs/effectts/json-ld-spott-wire-contract.md`](../effectts/json-ld-spott-wire-contract.md). Kort:

- deadline / `AbortSignal` doorgegeven en gehonoreerd;
- faultcategorieën zoals tabel hierboven;
- retry-budget + `Retry-After`;
- concurrency via bestaande limiter / Spott 600 req/min;
- cleanup van timers/fetch bij cancel;
- tracing/critical-path labels waar het pad al instrumenteert;
- wire-resultaat: typed DTO of JobPosting-extractie zonder PII in artifacts.

### 5. Baseline-artifact en regressieruimte (vóór vergelijking)

Te meten (herhaalde fixturecohorten, sandbox only):

- latency p50/p95 (listing + detail/list + get);
- request/attempt counts;
- cancellation latency en achterblijvende I/O/timers;
- resource release;
- peak RSS;
- build- en typechecktijd;
- serverbundelgrootte (observe);
- directe dependency-count;
- adapter-/regelcode-omvang (observe; LOC-reductie ≠ succes);
- reviewrubric-uitkomst per variant.

**Toegestane regressies / releasecriteria (pre-agreed):**

1. Geen correctnessverlies op fixturecohorten.
2. Geen verhoging van het gecombineerde request×task retry-plafond zonder expliciet ADR/issue.
3. p95 latency: observe-only tot ≥20 homogene successen; daarna ADR-0003 (>+20% én >15s t.o.v. mediaan → warn; harde gate alleen met absoluut budget + MAD + bevestigingsbatch).
4. RSS/build/typecheck: warn-first; geen PR-blok zonder vooraf gepubliceerd absoluut budget in dit artifact.
5. Hergebruik telt pas wanneer de **tweede** adapter hetzelfde wire-contract deelt (CTP-455); pure LOC-daling is geen succescriterium.
6. Geen productieactivatie, geen live providerwrites, geen PII in committed artifacts.

## Gevolgen

- CTP-455 mag Effect-adapters alleen mergen wanneer het wire-contract en de fault/retry-tabel hierboven intact blijven of bewust via nieuw ADR wijzigen.
- First-party `effect`/`@effect/*`-pins horen in de migratie-PRs (niet stilzwijgend via Prisma-transitief).
- Harness dry-run bewijst scaffolding, niet de product-SLO.

## Verificatie

- ADR + wire-checklist + schema/template + dry-run harness + gerichte tests (PR #190).
- Live warm/cold fixturecohort-meting (native path): `bun scripts/effect-baseline/harness.ts --measure --run-kind cold|warm` met evidence onder [`docs/evidence/ctp-454/`](../evidence/ctp-454/).
- Effect dual-path vergelijking: **blocked-on-CTP-455** (geen first-party `effect` pin); native baseline + reviewrubric wel vastgelegd.
- Productieactivatie blijft uit; fixtures/sandbox only.

## Referenties

- [ADR-0001 — Performance-evidencecontract](ADR-0001-performance-evidence-contract.md)
- [ADR-0003 — Performancebudgets en regressiebeleid](ADR-0003-performance-budgets-and-regression-policy.md)
- [Performance-evidence runbook](../runbooks/performance-evidence.md)
- [Spott slice B spike](../spott-slice-b-spike.md)
- [CTP-454](https://linear.app/rcjt-studio/issue/CTP-454/effectts-leg-platformbaseline-foutsemantiek-en-meetcriteria-vooraf)
