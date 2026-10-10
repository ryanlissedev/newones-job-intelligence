# Worker-slot load proef (CTP-634)

Besluitinstrument: meet of één fetch-worker voldoende capaciteit heeft of dat een tweede worker zich terugverdient — met een loadproef, niet met een theoretische berekening.

## Wat het doet

`run.ts` draait dezelfde ingest-corpus op 2, 4, 6 en 8 **bron-slots** (plus level 1 als productie-vorm-baseline: de deployed worker draait één consumer) — één slot is één onafhankelijke `runDurableBronJobConsumer`-takeloop op de echte `curated.durable_job`-queue die `runBronIngestPipeline` end-to-end rijdt (fixture connectors, geen live egress).

- Corpus: de 13 JSON-LD-bronnen die CTP-630/637/638 end-to-end bewezen, elk `K5_ITEMS_PER_BRON` gemunte detail-items per job. Elk gemunt item serveert een committed fixture-body; `bronReferentie` is uniek per item. De corpus-digest staat in de output zodat levels nooit stil verschillende workloads vergelijken.
- Per level een verse wegwerp-database `ji_k5_l<N>_*` (aanmaken → grants → Drizzle-migraties → seed → run → drop), zodat iedere slot-count identieke begintoestand ziet. Gedeelde/dev-databases worden nooit aangeraakt.
- Gemeten per level: wall clock, per-job duur en offer→zichtbaar freshness, RSS-piek, CPU (user+system), event-loop lag (p95/p99/max), pool-reserve-wait op de eigen runtime-pool, sentinel app-read-latency op een dedicated connectie, pg backend-piek en `pg_stat_database`-deltas.

## Draaien

```sh
bun run bench:worker-slots
```

Env-knoppen: `K5_LEVELS="2,4,6,8"` (1 mag ook, voor de production-shape baseline), `K5_ITEMS_PER_BRON=20`, `K5_CRAWL_DELAY_MS=5`, `K5_RATE_LIMIT_PER_MINUTE=600`, `K5_LEVEL_DEADLINE_MS=600000`, `K5_OUTPUT_DIR=.artifacts/performance/worker-slots`, plus de `POSTGRES_*`-credentials uit `tools/postgres/test-isolation.ts` (zelfde defaults: `ji_admin`/`ji_migrator`/`ji_app` op `127.0.0.1:5432`). `RAW_S3_*` wordt per level weggesaneerd — de raw store is altijd het wegwerp-filesystem-pad, nooit een echte bucket.

Output: een machine-leesbare `k5-worker-slot-load-<timestamp>.json` in `K5_OUTPUT_DIR` + een samenvattingstabel op stdout. `.artifacts` is vluchtig bewijs; de vastgelegde run voor het besluit staat in `docs/evidence/ctp-634/`.

## Grenzen van de meting

- Minted items delen per bron een kleine set fixture-bodies: reëel per-item pipelinewerk (persist + normalise + curate, of het opgenomen soft-404-reject-pad bij Heijmans), géén reële contentdiversiteit. Rejecties worden expliciet als `itemsRejected` gerapporteerd.
- De seeded limiter is de spec-test-pacing (`crawlDelayMs=5`, `rateLimitPerMinute=600`), niet de productie-politeness — de proef meet het plafond van pipeline+DB-werk per slot, geen bron-etiquette.
- Alle slots delen één `PollBronRuntime` met één pool (max 10): precies het "meer slots in één proces"-scenario dat de tweede-worker-vraag beantwoordt.
- `SEARCH_PROJECTOR=onbox`: outbox-drain naar Manticore is uitgesloten; freshness is offer→pipeline-voltooid, niet offer→zoekbaar.
- Absolute getallen zijn on-box evidence voor deze hardware, geen productieprojectie.

## Spec-dekking

`probe.spec.ts` dekt de deterministische logica (corpus, minted listing, level-parsing, percentielen, rollup). De loadrun zelf is operator-ingeroepen en staat bewust niet in de gate — net als `benchmarks/bron-dashboard`.
