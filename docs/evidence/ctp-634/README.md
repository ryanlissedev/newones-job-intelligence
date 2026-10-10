# CTP-634 evidence — worker-slot load proef: second-worker decision

Question: _beslis met een loadproef of een tweede worker nodig is_ — decide by
measured load, not by a theoretical estimate, whether one fetch-worker process
is enough or a second worker pays for itself.

Harness: [`benchmarks/worker-slots/`](../../../benchmarks/worker-slots/README.md)
(operator-invoked, never a gate test) · Base commit:
`5f7d05da77264291d2e41efba8e9377c8968fdce`

## Decision

**GO — one worker process is sufficient. No second worker, no second host.**

The same 520-item fixture corpus completes at every level with **zero failed
jobs, zero job errors, zero deadlocks and no deadline hit** — including
**level 1, the production shape**: `apps/worker` today runs exactly one
`runDurableBronJobConsumer` take loop, and that single slot clears the whole
corpus in 58.8 s at 8% CPU with event-loop p95 1 ms. Scaling 1 → 8
bron-slots cuts wall time ~5.9× while event-loop lag stays flat (p95 1 ms,
max 2–3 ms), pool-reserve wait stays at p95 0 ms on the shared runtime pool,
sentinel app-read latency stays at p95 1 ms, and peak RSS grows only
195 → 250 MB. The in-process ceiling is not in sight at 8 slots — and the
deployed single slot already has the headroom. Capacity is not the
constraint a second worker would relieve; the binding constraint in
production is per-bron politeness pacing, which a second host cannot change.
Adding slots inside the existing process remains a config-level lever that
measurably buys freshness (p95 58.8 s → 9.9 s) if ever needed.

No lease, no order, no provisioning was performed; none is requested.

## Measured ladder (identical corpus, fresh `ji_k5_l<N>_*` DB per level)

Source: [`k5-worker-slot-load-2026-09-22T16-45-38-094Z.json`](./k5-worker-slot-load-2026-09-22T16-45-38-094Z.json)
· per-level schema-conformant records: [`records/`](./records/)
(measured on the post-review harness at commit `a438349`+fixes — level 1 is
the production-shaped single-consumer baseline)

| Slots | Wall s | Job p50 ms | Job p95 ms | Fresh p95 ms | EVL p95/max ms | Pool p95 ms | Sent p95 ms | RSS peak MB | CPU | Backends | Failures |
| ----: | -----: | ---------: | ---------: | -----------: | -------------: | ----------: | ----------: | ----------: | --: | -------: | -------: |
|     1 |   58.8 |       4524 |       4641 |        58803 |            1/3 |           0 |           1 |         195 |  8% |       16 |        0 |
|     2 |   31.6 |       4526 |       4546 |        31614 |            1/2 |           0 |           1 |         225 | 11% |       17 |        0 |
|     4 |   18.5 |       4718 |       4758 |        18468 |            1/3 |           0 |           1 |         235 | 16% |       19 |        0 |
|     6 |   14.2 |       4835 |       4865 |        14215 |            1/3 |           0 |           1 |         243 | 20% |       20 |        0 |
|     8 |   10.0 |       5148 |       5177 |         9941 |            1/3 |           0 |           1 |         250 | 27% |       22 |        0 |

Each level: 13 durable `bron-ingest` jobs completed in 13 attempts
(no retries), 510 items persisted and **10 items rejected** per level —
Heijmans' committed fixture set includes one recorded soft-404 page that the
parser correctly rejects (`status: "rejected"`, "no JobPosting JSON-LD found
on detail page"). Cycling 4 fixtures over 40 items hits that fixture exactly
10 times. The rejections are part of the measured pipeline work — fetch →
parse → reject record — and are reported as `itemsRejected` in the results
JSON, not mislabeled as dedupe.

Signals that matter for the decision:

- **Level 1 = production shape.** The deployed worker runs one consumer
  loop; that single slot clears the corpus in 58.8 s at 8% CPU — the
  GO decision does not depend on enabling more in-process slots.
- **Event-loop lag** p95 pinned at 1 ms, max 2–3 ms even at 8 slots — the
  single-process scheduler is nowhere near saturation.
- **Pool wait** (`sql.reserve()` on the runtime's own postgres-js pool,
  max 10) p95 0 ms — connections are never contended.
- **Sentinel app-read** (`count(*)` on `curated.aanvraag`, dedicated
  connection — the API/DB responsiveness stand-in) p95 1 ms.
- **Postgres** deadlocks 0; backend peak 16 → 22, commits scale with
  throughput; `tup_returned`/`tup_inserted` deltas in the JSON.
- **RSS** peak 195 → 250 MB across the ladder; CPU utilisation 8% → 27%
  of one 18-core box — headroom, not pressure.
- **Freshness** (offer → pipeline-complete) p95 improves 58.8 s → 9.9 s as
  slots scale: more slots help latency-bound work inside one process.

## Hardware, corpus, semantics

- Host: Apple M5 Pro, 18 cores, 64 GiB, macOS arm64 (darwin 27.0.0); Bun
  1.4.2; Postgres 16.14 (`catapulze-job-intelligence-postgres-1`,
  `127.0.0.1:5432`); `SEARCH_PROJECTOR=onbox` (no outbox→Manticore drain).
- Corpus: the 13 JSON-LD bronnen proven end-to-end by CTP-630/637/638 × 40
  minted detail items each = 520 items; digest
  `sha256:99132f84ce8b79ba92876e23695faad25…`
  pins bronnen × items × fixture **bodies** (URL→content-sha256) so levels
  can never compare different workloads — a fixture edited under the same
  URL changes the digest.
- One slot = one independent `runDurableBronJobConsumer` take loop on the
  real `curated.durable_job` queue driving `runBronIngestPipeline`
  end-to-end (discover → fixture fetch → raw write → normalise → dedupe →
  commit → curate → outbox row) — the optimized durable path, measured
  on-box, not the 136-minute theoretical estimate.
- Fixture connectors only; no live flags set; no egress. The harness scrubs
  `RAW_S3_*` per level so `createRawObjectStore` can never pick a real
  durable bucket — raw payloads stay in a per-level `ji-k5-raw-*` tempdir,
  removed on exit. Disposable `ji_k5_l<N>_*` databases created, migrated,
  seeded, measured and dropped per level — including on provisioning
  failure; shared/dev databases untouched.

## Alternatives investigated

| Alternative | Verdict |
| --- | --- |
| Theoretical sizing (~136-min estimate) | Rejected as the basis — measured on-box instead. |
| More slots in the existing process (vertical) | **Available, not required.** Scales cleanly 1→8 with every health signal flat; the single-slot production shape already suffices, extra slots are a config-level freshness lever. |
| Second worker process on this box | Not justified — no contention signal (event loop, pool, sentinel) to relieve. |
| Second host (worker isolation) | Not justified — see conditional placement plan below. |
| exe.dev as worker host | Validation-only by policy; never silently becomes production. |

## Conditional placement plan (only if a future probe flips the decision)

If a later, larger/production-shaped envelope shows in-process saturation:

1. Run fetchworkers on a host **near Postgres** (same region/LAN as the
   database box — Hetzner side, not across the WAN) so `bron-ingest`
   dequeue + pipeline writes stay low-latency.
2. Keep a **shared host limiter** (the per-bron `crawlDelayMs` +
   `rateLimitPerMinute` already in `curated.bron`) as the single politeness
   authority across all workers — never per-worker budgets that multiply
   source pressure.
3. Re-run this harness on the candidate box before ordering anything.

## Cost ceiling

- Spent on this decision: **€0** — on-box probe on disposable databases only.
- Ceiling if a future decision approves a second worker host: one small
  worker class host (~2 vCPU / 4 GB) near the database — indicative
  **≤ €10–15/month** at Hetzner-class pricing. **Not approved, not
  provisioned.** Any spend requires a separate, explicit budget approval;
  this document is not that approval.

## Interpretation limits

- Minted items share one fixture body per bron: real per-item pipeline work
  (persist → normalise → curate, or the recorded soft-404 reject path), but
  not real content diversity; dedupe/reject effects are part of the
  measurement, not noise around it.
- Seeded pacing is spec-test pacing (`crawlDelayMs=5`,
  `rateLimitPerMinute=600`) — the probe measures the pipeline+DB ceiling
  per slot, not production source etiquette. Production bronnen carry
  slower politeness budgets; that makes production load _easier_ per
  second than this probe, not harder. The corollary: production wall time
  per job is longer, so the measured slot-scaling understates how much
  freshness extra in-process slots buy — it never overstates it.
- `SEARCH_PROJECTOR=onbox`: freshness is offer→pipeline-complete, not
  offer→searchable. The Manticore drain is a separate lane.
- Absolute numbers are on-box evidence for this hardware, not a production
  projection. The ladder shape (flat event loop/pool/sentinel, sublinear
  wall-time scaling) is the decision-relevant signal.

## Open points

- A hypothetical >8-slot or multi-queue configuration would need a runtime
  pool larger than max 10 — retest before raising slot counts.
- Re-probe when the production corpus (live pacing, real content diversity,
  outbox→search drain) exists — this envelope is the in-process ceiling
  proof, not a live-traffic forecast.

## Reproduce

```bash
# focused unit specs (measurement logic, not the load run)
bun test benchmarks/worker-slots/probe.spec.ts
bun run check-types:benchmarks

# the load proef itself (operator-invoked; creates/drops ji_k5_* DBs)
# default ladder is 2/4/6/8; add 1 for the production-shaped single-slot baseline
K5_LEVELS="1,2,4,6,8" K5_ITEMS_PER_BRON=40 bun run bench:worker-slots
```

See [commands.md](./commands.md) for the exact commands and environment of
this evidence run.
