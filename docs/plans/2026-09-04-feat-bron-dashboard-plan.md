---
title: Brondashboard - inzichten per bron en totaal - Plan
type: feat
date: 2026-09-04
origin: docs/IMPLEMENTATION_BACKLOG.md (JI-030, JI-032), docs/AGENT_NATIVE_ARCHITECTURE.md (c/bi)
reference: ryanlissedev/motian `app/scraper` (commit 17c76bb) en https://motian.vercel.app/scraper
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
execution: code
linear_parent: RJC-340 (Slice C)
linear_epic: RJC-406 (D1–D11 = RJC-407…RJC-417)
---

# Brondashboard - inzichten per bron en totaal

## Goal Capsule

- **Objective:** Een operator ziet in één scherm per bron en in totaal hoe de ingest loopt: gezondheid, laatste en volgende run, volumes (gevonden / nieuw / gewijzigd / ongewijzigd / rejected / fouten), trend over tijd, faalredenen en open alerts. Elke tegel is ook als MCP/REST-capability opvraagbaar, zodat agents dezelfde cijfers zien als mensen.
- **Means:** Bestaande `curated.scrape_run` + `curated.bron` + `staging.aanvraag_observation` als bron van waarheid; nieuw read model in `marts`; capabilities in het registry; Next.js-route `/bronnen` met recharts; Postgres-persistente `bronHealth`/`alerts`.
- **Referentie:** Het Motian `/scraper`-dashboard (v1). We nemen de bewezen onderdelen over en repareren de tekortkomingen die daar in productie zichtbaar waren (17s cold-start, lifetime-cijfers zonder venster, "Achterstallig" op alle scrapers zonder oorzaak).
- **Stop conditions:** Geen alert-routing naar Slack/e-mail (RJC-342), geen screenshot/LLM-diagnose (JI-034), geen kostenmeting per run (JI-035), geen self-serve bron-onboarding uit de UI (Motian `platform-onboarding-drawer`), geen overlap-groepen tussen bronnen in de eerste oplevering.

---

## 1. Wat Motian doet (geleerd)

Bron: `app/scraper/page.tsx` (804 regels), `src/services/scraper-dashboard.ts` (1270 regels), `src/services/scrape-results.ts`, `src/services/record-scrape-result.ts`, `trigger/scraper-health.ts`, `src/lib/cron-slo-thresholds.ts`.

### 1.1 Wat het toont

| Sectie | Inhoud | Datamodel |
|---|---|---|
| KPI-rij (6 tegels) | Totaal runs · Actieve vacatures · Overlapgroepen · Nieuw toegevoegd · Bijgewerkt · Platforms met aandacht | `scrape_results` som over alle tijd, `jobs` count, overlap precompute |
| Trigger.dev zichtbaarheid | Per cron-taak laatste run + SLO-badge groen/amber/rood (`expectedMaxGapHours`, amber tot 1.5×) | `runs.list()` via Trigger.dev API, Upstash-cache 5 min |
| Per-platform gezondheid (card per bron) | Status `gezond / waarschuwing / kritiek / inactief`, slagingspercentage lifetime + 24u-venster, nieuw / bijgewerkt / mislukt-24u / overlap, cron-schema, laatste run, volgende run, gem. duur, max 2 signalen, laatste fout, badge "Circuit geopend" | `scraper_configs` (lastRunAt, lastRunStatus, consecutiveFailures, cronExpression) + `scrape_results` |
| Overzicht scrape-runs (tabel) | Recente runs: platform, tijd, status, gevonden, nieuw, bijgewerkt, overgeslagen, duur, fouten → run-detailpagina met de jobs van die run (`job_ids`) | `scrape_results` |
| Recente activiteit en logs | Feed met status, aantallen en eerste foutmelding per run | `scrape_results.errors` |
| Overlap tussen bronnen | Groepen listings die waarschijnlijk dezelfde opdracht zijn (5 strategieën, precompute elke 2u) | `overlap_groups` |
| "Hoe lees je deze cijfers?" | Uitleg van Overlap / Bijgewerkt / Nieuw / Overgeslagen | statisch |
| Platformcatalogus | Onboarding-drawer en config-formulier per platform | `platform_catalog`, `scraper_configs` |

### 1.2 Gezondheidsregels (`derivePlatformHealth`)

Pure functie, goed getest, overnemen:

| Code | Niveau | Conditie |
|---|---|---|
| `inactive` | info | scraper uit → status `inactief`, geen verdere signalen |
| `never_run` | warning | geen `lastRunAt` |
| `circuit_breaker_open` | critical | `consecutiveFailures >= 5` |
| `schedule_overdue` | warning (critical bij open circuit) | `nextRunAt <= now` |
| `recent_failures` | warning, critical bij ≥ 3 | mislukte runs in 24u |
| `partial_run` | warning | laatste run `partial` |
| `latest_error` | warning, critical bij laatste run `failed` | laatste foutmelding aanwezig |

Status = critical als één critical, anders warning als één warning, anders gezond.

### 1.3 Operationele automatisering

- **Silent-failure detectie** (`record-scrape-result.ts`): 3 opeenvolgende runs met `jobsFound = 0`, direct na een run mét jobs, en historisch max ≥ 10 in 30 dagen → `validationStatus = drift_suspected`. Vuurt één keer op de transitie, niet elke run.
- **Circuit breaker** met dagelijkse health-taak: reset bij succes in 72u, anders een probe (`testImport limit 1`), anders stale-reset na 48u zodat een platform nooit permanent dood blijft.
- **SLO-drempels** per cron in één bestand, gedeeld door dashboard-badge en health-check.

### 1.4 Wat er misging (uit `docs/solutions/performance-issues/scraper-dashboard-cold-start-17s-to-1s-2026-04-16.md` en `docs/doelplaat/componenten.md`)

1. **17 s cold-start.** Dedup-CTE over 53k rijen voor één scalar, externe Trigger.dev-call per pageload, sequentiële awaits op één Neon-connectie, geen Suspense-grens. Fix was: cached scalar, cache met `!= null`-guard (een gecachte `0` viel eerder door naar het trage pad), parallel laden, Trigger.dev-visibility gecached met 1 s timeout.
2. **Lifetime-cijfers zonder venster.** "Slagingspercentage over alle runs" telt `partial` als succes en middelt over maanden; een bron die vandaag kapot is blijft groen.
3. **Alles "Achterstallig".** Op 25-08-2026 stonden alle scrapers op achterstallig en MiPublic op "Circuit geopend" zonder dat het dashboard de oorzaak (scheduler niet gedraaid vs. bron kapot) onderscheidde.
4. **Één pagina van 804 regels** met health, overlap, catalogus en logs door elkaar; het overlap-blok was het duurste en het minst operationeel.
5. **Fouten als `string[]`** zonder classificatie; een tabel-tooltip is de enige plek waar je ze leest.

---

## 2. Wat Catapulze al heeft (en niet)

| Behoefte | Status in deze repo | Waar |
|---|---|---|
| Run-record per bron | ✅ `curated.scrape_run`: `status`, `run_kind`, `gestart`, `geindigd`, `aantal_gevonden`, `nieuw`, `gewijzigd`, `rejected`, `gesloten`, `fouten`, `failure_phase/class/code/message`, `circuit_status`, `checkpoint` | `packages/db/src/schema/curated.ts:77-166` |
| Ongewijzigd per run | ✅ maar alleen in `staging.aanvraag_observation.outcome = 'unchanged'` | `packages/db/src/schema/staging.ts:68-103` |
| Duur per run | ⚠️ geen kolom; `geindigd - gestart` | idem |
| `gesloten` | ✅ geschreven uit `lifecycle.staled` (`scrape_run.gesloten`) | `packages/db/src/bron-runtime.ts:338-345`, `apps/worker/src/poll-bron-run.ts:41-47` |
| Faalclassificatie | ✅ vaste envelope van 8 tuples, DB-check afgedwongen | `packages/connectors/src/run-lifecycle.ts:10-56` |
| Bronregister met cron | ✅ `curated.bron.interval`, `actief`, `status`, `rate_limit_per_minute` | `curated.ts:18-75` |
| Laatste run per bron via API | ✅ `list_bronnen` → `PublicBronView.lastRun` | `packages/application/src/registry/capabilities.ts:150` |
| Run-historie via API | ❌ geen capability | — |
| Gezondheid / alerts | ⚠️ `get_bron_health`, `list_alerts`, `ack_alert` bestaan maar de stores zijn in-memory in productie | `apps/server/src/assert-production-persistence.ts:13-22` |
| Stilte-detectie | ⚠️ `evaluateSilence` bestaat en is getest, maar wordt nergens aangeroepen | `packages/application/src/observability/silence.ts` |
| Charts | ✅ recharts 3 + `WeeklyVolumeChart`, `HorizontalBars`, `RateHistogram` | `apps/web/src/components/dashboard/charts.tsx` |
| UI-primitieven | ⚠️ `card`, `skeleton`, `tooltip`, `button`; geen `table`, `badge`, `tabs` | `packages/ui/src/components` |
| Rolgating in web | ❌ alleen "ingelogd" (`/dashboard`); rollen bestaan server-side (`recruiter/operator/admin/approver`) | `apps/server/src/capabilities/auth.ts` |
| Marts-schema | ⚠️ gedeclareerd, nul tabellen | `packages/db/src/schema/schemas.ts:5` |
| Legacy Motian-bronrijen | ⚠️ 7 rijen (`…0030`–`…0036`) met dezelfde `naam` als live bronnen | `de live-bronnenstatus van 2026-09-03 (intern, niet in deze repo)` |

**Conclusie:** de data is rijker dan bij Motian (ongewijzigd apart, faalenvelope, lifecycle), maar niets ervan is via API of UI zichtbaar. Het werk is een read model + capabilities + één pagina, niet nieuwe instrumentatie.

---

## 3. Ontwerp: wat we overnemen, wat we anders doen

### 3.1 Overnemen van Motian

- KPI-rij totaal + card per bron + run-tabel + run-detail + activiteitenfeed + uitlegkaart.
- `derivePlatformHealth`-regels als pure functie `deriveBronHealth` met dezelfde signaalcodes, aangevuld met `silence_open` (uit `bron.stil`-alert) en `scheduler_stale`.
- Schema-kaart per bron: cron, laatste run, volgende run, gem. duur.
- Silent-failure-transitiedetectie (alleen op de transitie vuren, historische baseline vereisen) — dit is precies `evaluateSilence` + dedupe key, dus alleen aansluiten.
- SLO-drempels in één bestand, gedeeld door UI-badge en health-check.

### 3.2 Anders doen (verbeteringen)

| Motian | Catapulze |
|---|---|
| Lifetime-succespercentage met `partial` als succes | Vensters **24u / 7d / 30d**, standaard 7d; `succeeded` telt als succes, `failed` en `cancelled` niet; lifetime alleen in run-detail |
| Alles op één pagina, overlap in het kritieke pad | Pagina in drie lagen: (1) totaal-KPI's + trend, (2) bronkaarten, (3) run-tabel; overlap/dedup buiten scope |
| Aggregaties per pageload, Trigger.dev API-call in het request-pad | **Geen externe calls in het request-pad.** Scheduler-heartbeat komt uit Postgres (laatste `poll`-run of `schedule-slice-a-polls`-tick), aggregaties uit geïndexeerde SQL met een p95-budget van 300 ms per query; pas precompute als de meting dat vraagt |
| `errors: string[]` | Faalenvelope `phase/class/code/message` → groepeer per `failure_code`, toon "top faalredenen (7d)" per bron en totaal |
| "Overgeslagen" als restpost | Vier expliciete kolommen: `nieuw`, `gewijzigd`, `ongewijzigd`, `rejected` + `fouten`; **ongewijzigd** uit observaties zodat "bron leeft maar niets nieuws" zichtbaar is |
| Groeperen op platform-naam | Groeperen op `bron_id` (legacy Motian-rijen delen `naam` met live bronnen); legacy `backfill`-runs apart getoond |
| Recruiters zien het dashboard | Route gated op rol `operator`/`admin` via sessie; capabilities `ROLE_OPERATOR` |
| Alleen UI | Elke tegel = capability (`get_bron_stats`, `list_scrape_runs`, `get_scrape_run`, `get_dashboard_overview`); MCP geeft dezelfde JSON als de pagina rendert |
| Circuit breaker op tabelkolom `consecutiveFailures` | Bestaande `scrape_run.circuit_status` + `bron.actief`; geen auto-reset zonder RJC-342 |

### 3.3 Read model (`marts`)

Twee views/queries, beide keyed op `bron_id`, met venster-parameter:

```
bron_run_stats(window)      -- per bron + rij "totaal"
  bron_id, naam, actief, interval,
  runs, succeeded, failed, cancelled, running,
  success_rate,                     -- succeeded / (runs - running)
  found, new, changed, unchanged, rejected, errors,
  avg_duration_ms, p95_duration_ms,
  last_run_at, last_run_status, last_failure_code, last_failure_message,
  next_run_at, is_overdue,          -- uit bron.interval (cron) + last_run_at
  top_failures: [{code, count}]

bron_run_timeseries(window, bucket=day)
  bucket, bron_id, runs, succeeded, failed, found, new, changed, unchanged, rejected, errors, avg_duration_ms
```

`unchanged` = `count(*) filter (outcome='unchanged')` uit `staging.aanvraag_observation` gejoined op `scrape_run_id`. Indexen: bestaande `scrape_run_gestart_idx` + `scrape_run_bron_id_idx`; nieuw `aanvraag_observation (scrape_run_id, outcome)` als de meting dat vraagt.

### 3.4 Pagina `/bronnen`

```
┌ Bronnen · venster [24u | 7d | 30d] ─────────────────────────────────────┐
│ KPI: Runs · Succes% · Nieuw · Gewijzigd · Ongewijzigd · Rejected · Bronnen met aandacht │
│ Trend (area, per dag): nieuw / gewijzigd / rejected, gestapeld; failed als lijn      │
├ Bronkaarten (grid) ──────────────────────────────────────────────────────┤
│ [TenderNed] gezond  succes 7d 96% ▓▓▓▓▓▓▓▓░  laatste run 12 min geleden   │
│  nieuw 14 · gewijzigd 3 · ongewijzigd 210 · rejected 0 · fouten 0        │
│  cron */15 · volgende 09:45 · gem. 4.2s · sparkline 7d                   │
│  signalen: —                                                            │
├ Runs (tabel, filter op bron/status/run_kind, paginering) ───────────────┤
│ tijd · bron · kind · status · gevonden · nieuw · gew. · ongew. · rej. · fouten · duur · faalcode → detail │
├ Uitleg: hoe lees je deze cijfers ────────────────────────────────────────┤
```

Run-detail `/bronnen/runs/[id]`: envelope, checkpoint (zonder secrets), lifecycle-samenvatting (`incremented/reopened/reset/staled`), en de observaties van die run (outcome-verdeling).

---

## 4. Implementation Units

Elke unit is een verticale slice met TDD en één PR. Volgorde is afhankelijkheidsvolgorde; D1 en D3 kunnen parallel.

| Unit | Linear | Titel | Laag | Blocked by | Prio |
|---|---|---|---|---|---|
| D1 | RJC-407 | Read model `bron_run_stats` + `bron_run_timeseries` in `packages/db` met venster en `unchanged` uit observaties | db + application | — | High |
| D2 | RJC-408 | `deriveBronHealth` pure functie + SLO-drempels per bron (`next_run_at`, `is_overdue`, `scheduler_stale`) | application | D1 | High |
| D3 | RJC-409 | Postgres `BronHealthStore` + `AlertStore`; `evaluateSilence` aansluiten in `poll-bron`; allowlist-entries verwijderen | db + worker + server | — | High |
| D4 | RJC-410 | Capabilities `get_dashboard_overview`, `get_bron_stats`, `list_scrape_runs`, `get_scrape_run` (REST + MCP, `ROLE_OPERATOR`) | application + server | D1, D2 | High |
| D5 | RJC-411 | Web route `/bronnen`: rolgating, totaal-KPI's, bronkaarten, uitlegkaart, nav-item | web | D4 | High |
| D6 | RJC-412 | Web: run-tabel met filters + run-detailpagina | web | D4 | Medium |
| D7 | RJC-413 | Web: trend-chart totaal + sparkline per bron (recharts, bestaande `charts.tsx`) | web | D4, D5 | Medium |
| D8 | RJC-414 | Bug: `scrape_run.gesloten` schrijven uit `lifecycle.staled`; `unchanged` ook op `PollBronRunResult` | worker + db | — | Medium |
| D9 | RJC-415 | Performance-budget en bewijs: p95 servertijd `/bronnen` < 1 s bij 50k runs, query-budget 300 ms, geen externe call in request-pad; precompute alleen als meting faalt | perf | D5, D6, D7 | Medium |
| D10 | RJC-416 | E2E live-spec + runbook `docs/runbooks/bron-dashboard.md` + MCP-pariteitstest (UI-cijfers == capability-JSON) | e2e + docs | D5–D7 | Medium |
| D11 | RJC-417 | (Later) Overlap tussen bronnen op basis van `curated.dedup_groep` als aparte sectie | web | D5 | Low |

### Acceptance criteria per unit

**D1**
- [ ] `bronRunStats({ window })` geeft per bron én een `totaal`-rij; sommen per bron tellen op tot totaal (property-test).
- [ ] `unchanged` komt uit `aanvraag_observation` en is 0 voor runs zonder observaties.
- [ ] `avg_duration_ms`/`p95_duration_ms` negeren `running`-runs.
- [ ] Legacy `backfill`-runs zijn uitgesloten uit `poll`-statistieken maar zichtbaar via `run_kind`-filter.
- [ ] Gegroepeerd op `bron_id`; de twee legacy rijen met dubbele `naam` blijven gescheiden (fixture-test).
- [ ] Postgres-spec draait geïsoleerd (RJC-369-patroon), geen vervuiling van dev-db.

**D2**
- [ ] `deriveBronHealth` is puur, `now` injecteerbaar, en dekt alle codes uit §1.2 plus `silence_open` en `scheduler_stale`.
- [ ] `next_run_at` uit `bron.interval` (5-veld cron, `Europe/Amsterdam`); `is_overdue` pas na 1× interval + 5 min grace.
- [ ] `scheduler_stale` vuurt wanneer géén enkele bron een `poll`-run had in 2× het kleinste interval — onderscheidt "scheduler dood" van "bron kapot" (Motian-les 3).
- [ ] Tabel-gedreven tests: één test per signaalcode, één per statusprecedentie.

**D3**
- [x] `PostgresBronHealthStore` en `PostgresAlertStore` met dezelfde contracttests als de memory-varianten.
- [x] `evaluateSilence` wordt in `runBronIngestPipeline` aangeroepen na `complete`; dedupe key voorkomt een tweede alert.
- [x] `VOLATILE_STORE_ALLOWLIST` verliest `alerts` en `bronHealth` in dezelfde PR; `assertProductionPersistence` blijft groen.
- [x] Migratie voor `curated.bron_health` en `curated.alert` (of hergebruik `audit_event` — beslis in de PR met ADR-notitie).

**D4**
- [ ] Vier capabilities in `capabilities.ts` met Zod-in/uitvoer, `ROLE_OPERATOR`, `audit_class: access`.
- [ ] `check:capability-coverage` en `check:capability-registry` groen; REST-paden `GET /v1/dashboard`, `GET /v1/bronnen/{id}/stats`, `GET /v1/scrape-runs`, `GET /v1/scrape-runs/{id}`.
- [ ] `list_scrape_runs` pagineert met cursor op `(gestart, id)`, filters `bronId`, `status`, `runKind`, `since`.
- [ ] `get_scrape_run` retourneert checkpoint met secret-velden gestript (DEC-008-minimalisatie).
- [ ] Contracttest: MCP-tool en REST geven byte-gelijke JSON.

**D5**
- [ ] `/bronnen` server-component; sessie zonder rol `operator`/`admin` → `redirect("/")` met toast; geen fetch naar Postgres vanuit web (`check-layering` groen).
- [ ] KPI-rij + bronkaarten renderen uit `get_dashboard_overview`; venster-switch is URL-state (`?window=7d`).
- [ ] Skeleton binnen Suspense-grens; lege staat "Nog geen runs" per bron.
- [ ] Nav-item "Bronnen" alleen zichtbaar voor operator/admin.
- [ ] `@ji/ui` krijgt `badge` en `table` (shadcn/base-ui) in deze unit.

**D6**
- [ ] Tabel met filters (bron, status, run_kind) en cursor-paginering; rijen linken naar `/bronnen/runs/[id]`.
- [ ] Detailpagina toont envelope, lifecycle-samenvatting, observatie-verdeling; onbekende run → 404.

**D7**
- [ ] `WeeklyVolumeChart`-patroon hergebruikt voor dag-buckets; kleuren via `--chart-*`; tooltips leesbaar in dark mode.
- [ ] Sparkline per bronkaart zonder eigen ResponsiveContainer per kaart (één gedeelde breedte-meting) — voorkomt layout-thrash bij 12+ kaarten.

**D8**
- [x] `progressValues` schrijft `gesloten` uit `lifecycle.staled`; bestaande runs blijven 0 (geen backfill).
- [x] `PollBronRunResult.metrics` krijgt `unchanged` zodat de Trigger.dev-run-output dezelfde vijf tellers toont als het dashboard.

**D9**
- [ ] Meting met `packages/performance` op een fixture van 50k `scrape_run`-rijen; p95 servertijd < 1 s, elke query < 300 ms.
- [ ] Bewijs in `.artifacts/performance/` en een regel in `de interne kostenkaart` of perf-ADR.
- [ ] Pas als budget faalt: Trigger-taak `refresh-bron-dashboard` (na `schedule-slice-a-polls`) die `marts.bron_run_stats_snapshot` vult; cache-guard met `!= null` (Motian-les 1).

**D10**
- [ ] Playwright live-spec in `e2e/live-jobs` (anonymous → redirect, operator → KPI's zichtbaar).
- [ ] Pariteitstest: cijfers in de DOM == `get_dashboard_overview`-JSON voor dezelfde `window`.
- [ ] Runbook: wat elke signaalcode betekent en welke actie hoort bij welk `failure_code`.

---

## 5. Verification Contract

- `bun run gate` (types, lint, tests, layering, secrets) groen per PR.
- `bun run check:capability-coverage` en `check:capability-registry` groen na D4.
- `assertProductionPersistence` groen na D3 met gekrompen allowlist.
- Perf-bewijs (D9) vóór de "done"-claim van de epic.
- Review: autoreview én eindreview tegen dit document; een fix na review maakt de review ongeldig.

## 6. Risico's

| Risico | Mitigatie |
|---|---|
| Aggregaties over `scrape_run` worden traag bij groei (elke 15 min × 12 bronnen ≈ 1.150 runs/dag) | Vensterqueries met index op `gestart`; D9 meet op 50k; precompute alleen bij bewezen noodzaak |
| `unchanged`-join op observaties is duur (miljoenen rijen) | Aggregatie per `scrape_run_id` met index; anders `unchanged` als kolom op `scrape_run` schrijven (D8-uitbreiding) |
| Rolgating in web is nieuw; rol zit in sessie maar wordt nergens gelezen | D5 leest `session.user.role`; server blijft de enige harde grens (capabilities `ROLE_OPERATOR`) |
| Legacy Motian-rijen vervuilen totalen | Groepering op `bron_id`, `run_kind`-filter, legacy alleen onder "backfill" |
| Overlap-sectie trekt scope naar zich toe (Motian-les 4) | Expliciet D11 Later; dedup bestaat al in `curated.dedup_groep` |

## 7. Niet in scope

Alert-routing en escalatieladder (RJC-342, JI-033), screenshot/LLM-diagnose (JI-034), kosten per run (JI-035), self-serve bron-onboarding, circuit-breaker auto-reset, Trigger.dev-runs-API in het request-pad.
