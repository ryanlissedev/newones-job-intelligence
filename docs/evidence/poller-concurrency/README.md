# Scrape-architecture PR6: 8 sources in flight, a global fetch/s cap and a curation cap

Recorded 2026-10-09 ~09:15 CEST on the box (fetch-cap run repeated ~10:30 CEST after the bot-review fixes: same numbers). No network beyond 127.0.0.1.

## 1. Round time: replay of the measured run durations (`replay-harness.ts`)

The per-source run durations measured on 2026-10-08 (MEASURED.md, log p50 incl. the
120 s curate pass) were replayed through the **real `runContinuously`** on a
scaled clock (1 simulated minute = 6 ms):

- Techniekwerkt 330 min, Randstad 103, ZZP 57, WvN 44, Opdrachtoverheid 34, …, TenMonks 8.
- Sixteen more sources at 3 min.
- Two durable bronnen that free their slot at once.

That is 33 sources, all always due (`*/15`), in longest-waiting order, for 30 simulated hours. The first 6 h are dropped as warm-up.

```
replay: 33 sources, 30 simulated hours (first 6 h warm-up dropped), 1 sim-min = 6 ms
slots=2: round (start-to-start per source) p10 6.62 h · p50 6.64 h · p90 6.64 h (n=78); short sources p50 6.64 h; Randstad 6.64 h; Techniekwerkt 6.62 h; peak in flight 2
slots=8: round (start-to-start per source) p10 1.00 h · p50 1.01 h · p90 1.01 h (n=720); short sources p50 1.01 h; Randstad 1.72 h; Techniekwerkt 5.50 h; peak in flight 8
```

The 2-slot replay gives 6.64 h against the **measured 6.27 h** prod p50, so the model is within 6%.
At 8 slots, every source except the two long crawls comes round about **every hour instead of every 6.6 h**.
Techniekwerkt is bounded by its own 5.5 h budget.

### With #465's long lane (local merge, not pushed)

The branch was merged locally with `fix/poller-long-source-budgets` (#465). The
merge is clean, `tsc` passes, and `pool.spec`, `slots.spec` and `run-budget.spec`
pass (31 tests). The same replay was run with `isLong` (Techniekwerkt, Randstad)
and `maxLongInFlight = concurrency - 1`:

```
replay: 33 sources, 30 simulated hours (first 6 h warm-up dropped), 1 sim-min = 6 ms
slots=2: round (start-to-start per source) p10 6.62 h · p50 6.64 h · p90 6.65 h (n=78); short sources p50 6.64 h; Randstad 6.65 h; Techniekwerkt 6.62 h; peak in flight 2
slots=2 +long-lane(#465): round (start-to-start per source) p10 6.04 h · p50 6.04 h · p90 6.05 h (n=98); short sources p50 6.04 h; Randstad 7.22 h; Techniekwerkt 7.22 h; peak in flight 2
slots=8: round (start-to-start per source) p10 1.00 h · p50 1.00 h · p90 1.02 h (n=720); short sources p50 1.00 h; Randstad 1.72 h; Techniekwerkt 5.50 h; peak in flight 8
slots=8 +long-lane(#465): round (start-to-start per source) p10 1.00 h · p50 1.00 h · p90 1.02 h (n=720); short sources p50 1.00 h; Randstad 1.72 h; Techniekwerkt 5.50 h; peak in flight 8
```

At 2 slots the lane keeps one slot for short sources, as #465 intends. At 8 slots
it allows 7 long runs, so it never binds with two long sources, and the one-free-slot
rule still holds unchanged.

## 2. Process-wide fetch cap (`fetch-cap-harness.ts`)

The setup:

- Eight sources in flight through the **real `executeBronRun` → `runConnector` → json-ld live fetch**, against a local host that logs every request.
- Each bron is paced at 100 ms, i.e. 10 req/s per host.

```
8 sources in flight, 15 detail pages each, each bron paced at 100 ms (10 req/s per host)
no process cap: 128 requests in 1.51 s → mean 84.9 req/s, peak 88 requests in any 1 s window
POLLER_FETCHES_PER_SECOND=8: 128 requests in 15.88 s → mean 8.1 req/s, peak 9 requests in any 1 s window
```

Without the cap, eight sources start about 85 requests per second together. With
`POLLER_FETCHES_PER_SECOND=8` the box starts 8.1 per second. A window of exactly 1 s
can hold the endpoints of 8 intervals of 125 ms (9 starts), so the peak of 9 is the
spacing plus timer jitter, not a burst.

### After the review fixes

- A request the cap held now reports its real start to its HostGate (`RequestLimiter.started`). The crawl delay therefore separates actual starts, not reservations (`fetch-rate-cap.spec`: held at 1000 ms → next start at 3000 ms, not 2000 ms).
- The inline curation pass after a poll only takes a free slot (`SlotLimit.tryRun`). When none is free it is skipped, and the poller's backlog drain counts and curates under its own budget (`discovery-floor-pipeline.spec`: slot held → `curationDeferred`, 2 awaiting → drain curates 2; on the pre-fix code that test hangs at the slot).

## Not measured here

Postgres load from curation is bounded by `POLLER_CURATE_CONCURRENCY` (default 2,
the old slot count). The slot limiter has its own spec (`slots.spec.ts`). A live
DB-load comparison needs the prod box, which is out of scope.
