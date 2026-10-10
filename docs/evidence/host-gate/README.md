# Scrape-architecture PR5 — HostGate: Retry-After, back-off, 403/Cloudflare circuit

Recorded 2026-10-09 ~10:10 CEST on the box. No network beyond 127.0.0.1.

`evidence-harness.ts` runs the **real json-ld connector and runner**
(`createJsonLdClient` live mode → `runConnector`, in-memory stores) against a
local `Bun.serve` "host" that logs every request reaching it:

1. **Rate limit:** six job pages; `/job/3` answers `429` with `Retry-After: 3`
   once.
2. **Cloudflare:** every detail page answers `403` + `cf-mitigated: challenge`;
   four poller runs back to back, one limiter instance across them (as
   `executeBronRun` keeps one per bron for the life of the process).

The same file ran unchanged on two trees:

- **base:** `git archive` of `feat/scrape-run-outcome-taxonomy` (#470,
  0f6b329), which has `CrawlDelayLimiter`;
- **PR5:** this branch (picks `HostGate` when the package exports it).

Crawl delay 500 ms, production retry policy (250 ms, ×2, 3 attempts).

## Results

| | base (CrawlDelayLimiter) | PR5 (HostGate) |
|---|---|---|
| 429 `Retry-After: 3` → retry of `/job/3` | **501 ms** later (header ignored) | **3002 ms** later |
| requests to the blocking host, run 1 / 2 / 3 / 4 | 4 / 4 / 4 / 4 (sitemap + 3 attempts) | 2 / 2 / **0 / 0** |
| total requests to the blocking host over 4 runs | **16** | **4** |
| run classification | `blocked` (from PR1) | `blocked`; runs 3–4 fail at discovery without a request |
| gate state after run 4 | n/a | `circuit: open`, `recentBlocks: 2`, open for 1 h |

### base

```
limiter: CrawlDelayLimiter, crawl delay 500 ms

Scenario 1 — host answers job/3 with 429 Retry-After: 3 (once)
  outcome: succeeded new=6 rejected=0, 3508 ms
  requests:
    +0ms 200 /sitemap.xml
    +500ms 200 /job/1
    +1003ms 200 /job/2
    +1499ms 429 /job/3
    +2000ms 200 /job/3
    +2499ms 200 /job/4
    +3000ms 200 /job/5
    +3500ms 200 /job/6
  gap 429 -> retry of /job/3: 501 ms (host asked for 3000 ms)

Scenario 2 — every detail page is a Cloudflare challenge (403); 4 poller runs back to back
  run 1: 4 requests reached the host -> failed (blocked): Connector fetch failed
  run 2: 4 requests reached the host -> failed (blocked): Connector fetch failed
  run 3: 4 requests reached the host -> failed (blocked): Connector fetch failed
  run 4: 4 requests reached the host -> failed (blocked): Connector fetch failed
  total requests to the blocking host over 4 runs: 16
```

### PR5

```
limiter: HostGate, crawl delay 500 ms

Scenario 1 — host answers job/3 with 429 Retry-After: 3 (once)
  outcome: succeeded new=6 rejected=0, 6009 ms
  requests:
    +0ms 200 /sitemap.xml
    +500ms 200 /job/1
    +1001ms 200 /job/2
    +1499ms 429 /job/3
    +4501ms 200 /job/3
    +5002ms 200 /job/4
    +5502ms 200 /job/5
    +6003ms 200 /job/6
  gap 429 -> retry of /job/3: 3002 ms (host asked for 3000 ms)

Scenario 2 — every detail page is a Cloudflare challenge (403); 4 poller runs back to back
  run 1: 2 requests reached the host -> failed (blocked): Connector fetch failed
  run 2: 2 requests reached the host -> failed (blocked): Connector fetch failed
  run 3: 0 requests reached the host -> failed (blocked): Connector discovery failed
  run 4: 0 requests reached the host -> failed (blocked): Connector discovery failed
  total requests to the blocking host over 4 runs: 4
  gate snapshot: {"circuit":"open","consecutiveRateLimited":0,"openUntil":"…T08:11:17Z (UTC)","pausedUntil":null,"recentBlocks":2}
```

In production the poller does not even start runs 3–4: `partitionByHostGate`
holds the source back (`poller_source_skipped`, `reason: "host_gate"`), and
`bron_health.circuit_status = 'open'` shows on `/bronnen`.

## Found while recording

The first PR5 run waited **30 s**, not 3 s: the json-ld live client surfaces a
429 as `HttpStatusError`, which dropped `Retry-After`, so the gate fell back to
its no-header back-off. `HttpStatusError` now carries `retryAfterMs` (parsed in
`readLiveHtmlOrThrow`, shared by json-ld, LinkedIn and Planet Interim); the
numbers above are after that fix.

## Reproduce

```
bun docs/evidence/host-gate/evidence-harness.ts
```
