# Rust/Go vs TypeScript voor de pipeline · Browserbase/Stagehand/Firecrawl

Datum 2026-08-27. Methode: `nationalevacaturebank.ts`, `striive.ts`, `dynamic-adapter.ts`, `mipublic.ts` gelezen (+ grep over 6.172 LOC in `motian/packages/scrapers`); identieke MinHash- en 50-concurrent-fetch-microbenchmarks op M4 (Bun 1.3.14, Go 1.25.2; Rust uit gepubliceerde cijfers — rustc SIGKILL lokaal). Scripts: `bench/`.

## Wat de scrapers echt doen

Geen cheerio: `JSON.parse` van `__NEXT_DATA__`/JSON-API's + regex (`dynamic-adapter.ts:91`). Chromium draait nooit op de worker: Striive via Playwright in Modal (`striive.ts:456`), mipublic één Browserbase-sessie hergebruikt (`mipublic.ts:543`), werkzoeken Browserbase-fallback (`werkzoeken.ts:297`), dynamic-adapter valt terug op Firecrawl. Fallback-keten al: direct → Browserbase → Firecrawl (`mipublic.ts:424`). Detail-concurrency 4, delays 300–3.000 ms, backoff op 429.

## Stap × runtime

| Stap | Bun/TS | Go | Rust | Winst | Telt hier? |
|---|---|---|---|---|---|
| 50-concurrent fetch, 2.000 × 100 KB (gemeten) | 66 ms, 88 MB RSS | 63 ms, 19 MB | ~20 MB @500 rps | wall 1,0×; RSS 4–5× | nee — 0,4–2,4 req/s; borden cappen op 4 |
| Static-page throughput (Apify 2026) | 10–15k/min | 20–30k | 35–50k | 2–3× | nee — "latency en rate limits domineren" |
| HTML-parse | JSON+regex | goquery | scraper | 1–3× | nee — parse is JSON |
| Headless Chromium | Playwright/Puppeteer; 2026 anti-detect-benchmark: 7 tools, alle Node/Python | chromedp/rod — in geen benchmark | chromiumoxide — idem | negatief | nee — ecosysteem is Node/Python |
| MinHash 128 perm, 20k × 2 KB (gemeten) | 597 docs/s (33,5 s), 167 MB | 12.437 docs/s (1,6 s), 90 MB | ≥ Go (rensa 100k in 5,5 s vs datasketch 92 s) | ~21× | nee — 100k docs/mnd = **168 CPU-s/mnd** in Bun |
| Postgres upsert | Bun 9.400 vs Node 8.900 rps | pgx binary COPY | sqlx | ~1× | methode telt: COPY + temp-merge 19× naïeve INSERT |

Geheugen op 8 GB: Bun-worker ~90 MB (50 in-flight), ~170 MB met dedupe-batch; Go 20–90 MB — beide houden 28 bronnen makkelijk. Trigger.dev's eigen Node→Bun-move (Firebun, mrt 2026): 192→85 MB, 2.099→10.700 req/s.

## Orkestratie als polyglot

Trigger.dev TS-native (Python via extension; geen Go/Rust) · River (Go, SOC 2) · Apalis (Rust, klein) · pg-boss (SKIP LOCKED, elke taal onofficieel) · Temporal (8 SDK's, Rust 0.7) · Inngest (TS/Python/Go, geen Rust).

## Migratiekosten

7 scrapers + adapter + registry (~6,2k LOC) + ~1,5k LOC Vitest: **Go 4–6 pw, Rust 7–10 pw** + 1–2 weken orkestratie. Striive's in-browser mapping is JavaScript-als-string (`striive.ts:13`) — blijft JS. Anti-bot/layout-fixes zijn de dominante levensduurkost; Playwright-forks (Patchright, rebrowser, CloakBrowser) zijn Node/Python.

## Managed diensten (1M fetches/mnd)

**Browserbase** (browserbase.com/pricing): Free 1 u; Developer $20 (100 u, 25 concurrent); Startup $99 (500 u, 100 concurrent, $0,10/u overage); Scale custom (EU Central/UK en "Verified"-browsers alleen daar). Proxies 1–5 GB incl., dan $10–12/GB. CAPTCHA-solving op alle plannen. Met sessie-hergebruik ≈ $0,00006/fetch browsertijd; **residential proxy is de kostenpost** (1M × 100 KB = 100 GB ≈ $1.000–1.200) — alleen per vijandig bord. Self-host Chromium wint pas > ~500 browser-uur/mnd en heeft één datacenter-IP zonder solver. EU-regio alleen Scale → DPA-check.

**Stagehand** (docs.stagehand.dev, /v3/best-practices/caching): `act/extract/observe`; cache-key = instructie + paginainhoud + URL → elke layoutwijziging is een miss + LLM-call; geen self-healing op hit. $0,002–0,02/call (secundair: dev.to). Op het hot path bij 1M fetches: **$2k–20k/mnd**. Wél bij onboarding (`observe()` → `scrapingStrategy` JSON, `dynamic-adapter.ts:24`; `src/services/platform-analyzer.ts` is dit idee al) en reparatie.

**Firecrawl** (firecrawl.dev/pricing, /pricing.md): Hobby $19 (5k) · Standard $99 (100k) · Growth $399 (500k) · Scale $749 (1M); geen pay-per-use, geen rollover; `["rawHtml","json"]` in één call (provenance); JSON-extractie +4 credits/pagina. Self-host: AGPL, Postgres+Redis+RabbitMQ+Playwright, **zonder fire-engine anti-bot** — dan is het je eigen fetch+Playwright met markdown-converter: nee.

## Verdict

(i) **Alles TypeScript.** Gemiddelde load 0,4–2,4 fetch/s; enige CPU-stap 168 CPU-s/mnd (bij 600k: ~17 CPU-min); 21× winst koopt minuten per maand tegen 4–10 pw + permanente anti-bot-belasting. Heroverweeg bij ≥ 10M docs/mnd of Chromium on-worker (geheugenvraag).

Ladder per bord (marginale kosten/fetch): 1 API/feed/`__NEXT_DATA__` — $0 · 2 eigen HTTP-connector/config-adapter — $0, ~1 dag/bord · 3 Firecrawl cloud — $0,0006–0,0008/pagina · 4 Browserbase — ~$0,00006/fetch + proxy alleen waar nodig; Stagehand alleen onboarding/reparatie.

Bronnen: browserbase.com/pricing · docs.browserbase.com/features/stealth-mode · docs.stagehand.dev · firecrawl.dev/pricing · docs.firecrawl.dev/contributing/self-host · docs.firecrawl.dev/features/scrape · github.com/firecrawl/firecrawl · use-apify.com/blog/web-scraping-languages-compared-2026 · ianlpaterson.com/blog/anti-detect-browser-benchmark-patchright-nodriver-curl-cffi · trigger.dev/blog/firebun · tigerdata.com/blog/benchmarking-postgresql-batch-ingest · github.com/beowolx/rensa · github.com/riverqueue/riverqueue-python · docs.temporal.io/develop · inngest.com/docs/sdk/overview.
