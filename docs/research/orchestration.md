# Orkestratie — Trigger.dev optimaliseren vs Temporal

Datum 2026-08-27. Bronnen: trigger.dev/pricing, /docs/limits, /docs/wait, /docs/queue-concurrency, /docs/triggering, /docs/machines, /docs/tasks/scheduled, /docs/troubleshooting-alerts, /docs/self-hosting/{overview,docker}, /docs/config/extensions/playwright, /docs/guides/examples/puppeteer; temporal.io/pricing, docs.temporal.io/cloud/{pricing,actions,regions}, /develop, /self-hosted-guide, temporal.io/changelog/rust-sdk-public-preview, github.com/temporalio/docker-compose. Lokaal gelezen: motian `trigger.config.ts`, `trigger/*.ts`, `src/services/scrape-pipeline.ts`, `docs/solutions/performance-issues/full-stack-performance-audit-20260414.md`.

## motian vandaag

`@trigger.dev/sdk` 4.4.3, 22 task-bestanden. Eén uurlijkse orchestrator (`trigger/scrape-pipeline.ts:14-27`): `maxDuration 1800`, `medium-1x`, `retry 2`; leest `scraperConfigs`, skipt platforms bij `CIRCUIT_BREAKER_THRESHOLD=5` (`src/lib/helpers.ts:58`), per-platform DB-`cronExpression` due-check, in-process pool concurrency 4 (`src/services/scrape-pipeline.ts:177`). Rendering off-machine: Firecrawl eerst (`packages/scrapers/src/dynamic-adapter.ts:35`), Browserbase via `puppeteer.connect({browserWSEndpoint})` (`werkzoeken.ts:334`, `mipublic.ts:340` sessie-hergebruik). Enige idempotency-key: cv-analysis. `trigger.config.ts` faalt de build als `DATABASE_URL`/`BROWSERBASE_*`/`FIRECRAWL_API_KEY` ontbreken; `onFailure` → Sentry (alleen payload-keys). Zwak: één trage bron houdt 30 min vast; crash retried alles.

## Prijzen (Trigger.dev)

Free $0 ($5 credit) · Hobby $10 ($10 credit, 50 concurrent) · Pro $50 ($50 credit, 100–200 concurrent, +$10/50). small-1x $0,0000338/s · medium-1x $0,000085/s · $0,000025/run. Waits > 5 s onbetaald; slot vrij bij ~60 s.

## Kosten per ontwerp

| | (a) run per fetch | (b) run per bron per sweep |
|---|---|---|
| 1M fetches, browser off-Trigger | ~$240 | **~$40–60** |
| 1M fetches, browser on-Trigger (medium-1x) | ~$500 | ~$100 |
| 6M fetches, browser off-Trigger | — | ~$230–250 (Pro + overage) |

(b) wint 4–5×: geen startup-overhead per run, één machine-seconde bedient 5 I/O-waits. Werkelijk volume uit de bronmatrix ≈ 1–1,2M → **~$50–100/mnd**.

## Hefbomen

1. Orchestrator behouden; `batchTrigger` één child-run per bron (≤1.000 items, 3 MB/item).
2. `queue: { concurrencyLimit: 1 }` + `concurrencyKey: bron` (beleefdheid); `idempotencyKey: ${bron}:${sweep}` + `idempotencyKeyTTL`; `ttl` tegen stale sweeps.
3. `small-1x` default; `medium-1x` + `retry.outOfMemory` alleen browser-zware bronnen.
4. `wait.for` op 429/403 (gratis > 5 s); circuit breaker (5) + 48 u auto-reset behouden.
5. `maxDuration` 300–900 s per bron; jittered retry.
6. Downstream (normalize/dedupe/export) triggeren op orchestrator-completion i.p.v. wall-clock-crons.

## Browser

Trigger's Puppeteer-guide: scrapen van derden zonder `browserWSEndpoint`-proxy "is prohibited" (suspensie-risico). Hybride: Playwright `launchServer()` op de Hetzner-box, tasks `chromium.connect(ws)` — dezelfde code-naad als `werkzoeken.ts:334`. Browserbase/Firecrawl als per-bron fallback.

## Self-host break-even

v4 compose: webapp (+Postgres, Redis), supervisor, registry, MinIO, s2-lite, optioneel ClickHouse; webapp 3+ vCPU/6 GB, worker 4+ vCPU/8 GB; geen checkpoints/warm starts. ~€60–80/mnd hw + ops. Break-even ≈ $150–200/mnd cloud.

## Temporal

SDK's: Go 1.48, TS 1.23, Python 1.32, Java/.NET/PHP/Ruby GA; **Rust v0.7 public preview sinds 2026-05-07**. Self-host: single-binary server + lokale Postgres (2–4 GB) + UI; past op één 16 GB-box naast Chromium. Cloud: Essentials $100/mnd incl. 1M actions (Frankfurt/Ireland/London); acties: workflow start 1, activity 1, heartbeat 1, schedule fire 3. Page-batch-activities met 60–120 s heartbeat → 1–1,5M actions ($100–125); naïef (activity per vacature) 3M+ ($200–250). Workflow per bron: `scrape:{bron}:{sweep}` = exactly-once; `continueAsNew`; `OverlapPolicy: Skip`.

| | Trigger Cloud | Trigger self-host | Temporal self-host | Temporal Cloud | pg-boss |
|---|---|---|---|---|---|
| €/mnd @1,2M | $50–100 | €60–80 + ops | €20–30 + ops | $100 floor | ~€0 |
| Polyglot | TS | TS | ja (Rust preview) | ja | TS |
| Durability | retries + keys | idem − checkpoints | event-sourced, replay | idem managed | at-least-once |
| Leercurve | laag (motian port) | laag + infra | hoog | hoog − infra | zeer laag |

**Besluit:** Trigger.dev Cloud (TS-runtime); self-host als de rekening structureel > $150–200; Temporal alleen bij Go/Rust-workers.
