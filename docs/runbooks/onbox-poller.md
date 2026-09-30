# On-box poller

## Why this exists

Polling used to be two Trigger.dev tasks. A schedule (`schedule-slice-a-polls`)
fired every 15 minutes in `us-east-1` and fanned out one `poll-bron` run per
source. Every task ran in Trigger's hosted compute, so every database round trip
crossed the Atlantic and was billed as compute. A poll run averaged 121 seconds
and regularly hit the 900 second `maxDuration`, which meant curation was cut off
mid-backlog: 35,817 observations sat in `awaiting_curation` and 16,079 in
`pending`, and the queue never drained. The bill for that one task was heading
toward roughly 150 dollars a month.

The poller is the same work in a long-running process on the box, next to the
database, following the pattern the search projector already established
([search-projector.md](search-projector.md)). Round trips are local, there is no
per-run compute bill, and a source that is behind gets a time budget to keep
curating instead of a task ceiling to hit. The Trigger schedule and the
`poll-bron` task were deleted in the same change, so there is one implementation
rather than two that can drift.

`enrich-incomplete`, `schedule-enrich-incomplete`, `drain-outbox` and
`backfill-neon-v1` stay on Trigger.dev. Only polling and curation moved.

## Running the poller

```bash
bun run poller   # apps/worker: bun src/poller/main.ts
```

Compose runs the same thing behind a profile:

```bash
docker compose --profile poller up -d poller
```

## Environment

Read through the typed contract in `packages/env/src/poller.ts`, which mirrors
`projector.ts`.

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | Ordinary data queries. May use a pooled endpoint. |
| `POLLER_DATABASE_URL` | yes | The session advisory lock only. Must be a direct endpoint; known Neon pooler hosts are rejected before the lock connection opens, because a pooler can move consecutive queries between backend sessions and silently break the singleton guarantee. |
| `POLLER_TICK_MS` | no, default 60000 | Longest gap between due-source re-evaluations; the loop wakes earlier whenever a run frees a slot. |
| `POLLER_CURATE_BUDGET_MS` | no, default 120000 | Per source, per poll run: how long the poller may keep curating that source's backlog after its poll run. |
| `POLLER_CONCURRENCY` | no, default 2 | How many due sources the poller runs side by side at once. See [Sources run side by side](#sources-run-side-by-side). |
| `POLLER_RUN_BUDGET_MS` | no, default 3600000 (1 hour) | Wall clock for one source's connector run. When it elapses the run stops at the next item, keeps what it observed and closes its row as incomplete. See [Runs that never finish](#runs-that-never-finish). |
| `POLLER_ABANDON_RUN_AFTER_MS` | no, default 21600000 (6 hours) | A `curated.scrape_run` still `running` after this is failed once per tick, before candidates are read. See [Runs that never finish](#runs-that-never-finish). |
| `POLLER_DURABLE_BRONNEN` | no, unset | Comma-separated source slugs dispatched through `curated.durable_job` (the `PersistedQueue` path) instead of an inline run. Unset = everything inline. Requires migration `0029_durable_job_queue` first — see [durable-bron-jobs.md](durable-bron-jobs.md). |
| `SEARCH_PROJECTOR` | no, pinned to `onbox` | The only accepted value. The poller polls and curates; the on-box projector owns every outbox drain. |
| `MANTICORE_URL` | no | Unused while `SEARCH_PROJECTOR` is `onbox`. Declared so the contract is one document. |
| `RAW_S3_BUCKET`, `RAW_S3_ENDPOINT`, `RAW_S3_REGION`, `RAW_S3_ACCESS_KEY_ID`, `RAW_S3_SECRET_ACCESS_KEY` | in production yes | Read by `createPollBronRuntime` in `apps/worker/src/poll-bron-run.ts`. With `NODE_ENV=production` the process refuses to start on the filesystem backend, because raw payloads written there would read back as null from the server (RJC-386, [raw-object-storage.md](raw-object-storage.md)). |
| `RAW_OBJECT_STORE_PATH` | no | Filesystem fallback only, never production. |
| `APP_RELEASE_SHA` | no | Falls back to Coolify's `SOURCE_COMMIT`. Echoed once in the `poller_started` log line. |
| `POLLER_HEARTBEAT_FILE` | no, default `/tmp/poller-heartbeat` | Where the liveness file is written. |
| `BLUETRAIL_LIVE`, `CTM_LIVE`, `FLINTER_LIVE`, `HARVEYNASH_LIVE`, `HERO_LIVE`, `INHUURDESK_LIVE`, `NEEDSTAFFING_LIVE`, `ONEFELLOW_LIVE`, `OPDRACHTOVERHEID_LIVE`, `PROACT_LIVE`, `STRIIVE_LIVE`, `TENDER_NED_LIVE` | per source, in production yes | The per source live flags, one per entry in `packages/application/src/sources`. See the next section. |

### Live flags decide real data or fixtures

`process.env[source.liveEnv] === "1"` is what switches a connector from a repo
fixture to the real site, exactly as it did under Trigger. The consequence is
sharper now that the process is long running: a container that starts with the
flags unset stays green and keeps committing fixture rows into `curated` as if
they were real listings.

So in production the poller refuses that. When `NODE_ENV=production`, a due
source whose live flag is not `"1"` is skipped, and the poller logs one
`poller_source_skipped` line with its `bronSlug` and `reason: "not_live"`.
Outside production nothing is skipped, because fixtures are the point there.

The flag name always comes from the source definition's `liveEnv`, never from a
list maintained by hand, so a new source in `packages/application/src/sources`
is covered the moment it is registered. Adding a source does mean adding its
flag as a pass through to the `poller` service in `docker-compose.yml` and to
the Coolify application, or the source will be skipped in production with the
line above.

## Cadence comes from the source, not the process

The old schedule had one cron expression for every source, `*/15 * * * *`. The
poller reads `curated.bron.interval`, a five field cron expression stored per
source, and evaluates it in `Europe/Amsterdam`, the same time zone the Trigger
schedule used.

Each evaluation is a pure decision over three inputs: the pollable sources
with their intervals, the most recent poll run per source, and the current
time. `apps/worker/src/poller/schedule.ts` models that as a table and a
function:

```ts
interface PollCandidate { bronId; bronSlug; interval; lastRunAt }
const dueCandidates = (candidates, now) => PollCandidate[]
```

A source is due when it has never run, or when its cron expression has a
scheduled time strictly after `lastRunAt` and at or before `now`. Changing a
source's cadence is a database update to `curated.bron.interval`, not a code
change and not a redeploy. An interval that is not a usable cron expression
makes the source never due, which is deliberate: a typo pauses one source rather
than crashing the loop.

`lastRunAt` is the newest poll run of any status, not the newest successful one.
A source that keeps failing therefore retries on its own interval instead of on
every tick. Because due-ness is derived rather than queued, ticks a source
misses while it is running — or while the poller is down — coalesce into one
follow-up run, never one run per missed tick.

`crawl_delay_ms` is unchanged and still paces individual requests inside one
source's run.

## Sources run side by side

The poller runs up to `POLLER_CONCURRENCY` sources at once, default 2, and
keeps scheduling while they run. There is no cohort barrier: an evaluation
starts every due source that has a free slot, and the loop re-evaluates on the
tick or the moment a run finishes — a long BlueTrail or Opdrachtoverheid crawl
therefore never holds back a short source's next scheduled check (CTP-619).
Each source still runs one at a time, and `crawl_delay_ms` still paces the
requests inside a source, so nothing here loosens politeness towards a host.

The reason is arithmetic. Sequentially a round costs the sum of every source's
run, and two sources dominate that sum: BlueTrail takes around 680 seconds and
Opdrachtoverheid around 940 seconds, both paced by their own `crawl_delay_ms`.
A full round over the ten pollable sources measured 33 to 38 minutes, so a
source on the usual quarter-hour `curated.bron.interval` could never be polled
on its interval, no matter what the interval said. Overlapping the long pollers
with the short ones is what makes the configured cadence reachable.

The scheduler is `runContinuously` in `apps/worker/src/poller/pool.ts`, a pure
helper with its own spec:

- Due sources start in longest-waiting order (`byLongestWaiting`): never-run
  sources first, then the oldest `lastRunAt`. A source whose run outlasts its
  interval re-enters the queue with a fresh, recent `lastRunAt`, so it queues
  behind shorter sources that waited longer — a permanently-due long crawl
  cannot starve them when slots are scarce.
- A source that throws is captured, logged as one `poller_source` line with
  `errorName` and `errorMessage`, and does not stop the sources beside it or
  the scheduler.
- One active run per source: an in-flight source is skipped until its run
  settles, and ticks it missed while running merge into at most one follow-up.
- The abort signal is checked before each start and is passed into connector
  discovery, fetch, limiter waits and retry backoff. SIGTERM therefore stops
  new sources and lets uncancellable persistence finish its current boundary;
  cancellable HTTP requests and waits stop promptly.

The scoped liveness fiber refreshes the heartbeat independently of source
progress, so a long connector or curation pass cannot make process liveness
look stale. Source progress and freshness are separate signals.

Postgres load is bounded by the same number. Each source's drain step runs
inside that source's budget, so `POLLER_CONCURRENCY` is also the ceiling on
concurrent `curateScrapeRun` drains: at the default that is two. Raising it
raises both the number of sites polled at once and the number of drains
competing for the database, so raise it in small steps and watch `poller_cycle`
durations rather than jumping to the source count.

## Runs that never finish

A `curated.scrape_run` row is opened before a poll and closed after it, so a
process killed mid-run leaves the row on `status = 'running'` and nothing ever
revisits it. Under Trigger, `maxDuration` kills left 148 such rows, which had to
be repaired by hand (CTP-490).

At most once per tick, before candidates are loaded, the poller calls
`abandonStaleRuns` (`packages/db/src/abandon-stale-runs.ts`, exported from
`@ji/db`). Every run still `running` whose `gestart` is older than
`POLLER_ABANDON_RUN_AFTER_MS` is marked failed with the one tuple
`scrape_run_failure_tuple_check` allows for a cause that was never recorded:

```
failure_phase = 'unknown'
failure_class = 'internal'
failure_code  = 'UNEXPECTED_FAILURE'
failure_message = 'Connector run failed'
```

`geindigd` is set in the same statement, because `scrape_run_completion_check`
requires it on any row that is not `running`. When the pass changes anything,
the poller writes one `poller_runs_abandoned` line with the count; a clean tick
writes nothing.

The six hour default is deliberately far above any healthy run: the longest
source takes around 940 seconds plus one curate budget. Anything that old is a
dead process, not slow work. It runs before the candidates are loaded so the
repaired run is already closed when the next evaluation reads the newest run
per source.

### Stopping a live run instead of waiting for the reaper (CTP-490)

The reaper only repairs rows a *dead* process left behind. A *live* process
whose run had stalled (an upstream that keeps accepting connections but never
returns, a listing whose detail fetches each hit their timeout and retries)
used to hold its row `running` for as long as the process lived; the 10
September Opdrachtoverheid audit found eight such rows, seven of them with
`found = 300` and no `geindigd`.

Every connector run now takes an `AbortSignal` (`ConnectorRunInput.signal`,
`packages/connectors/src/run.ts`) that the poller builds from two sources:

- the process shutdown signal (SIGINT / SIGTERM), so a redeploy no longer
  leaves the current run `running`;
- `AbortSignal.timeout(POLLER_RUN_BUDGET_MS)`, so a stalled run is bounded
  even without a restart.

When the signal fires, cancellable connector requests and limiter/retry waits
stop at once. An uncancellable persistence call is allowed to finish its
current item; a persistence error remains a run failure. The run then stops
before the next item, persists the metrics it has and closes the row through
the normal `complete` path with
`completeness = { complete: false, reason: "aborted" }`. Nothing observed so
far is lost: observations whose persistence completed before the abort remain
in the object store and observation table. The interrupted page keeps the checkpoint it *started*
from, because the items after the cut were never seen, so the next poll
re-reads that page. Missed-poll reconciliation treats `aborted` like
`truncated` and `resumed`: it never stales a record the run did not reach.
The poller logs one `poller_source_incomplete` line with the reason.

A signal that fires after the last page was already read in full is ignored;
the run is complete and reported as such.

What this does **not** do, and what an operator still owns:

- Rows already stuck in production before this shipped are repaired by the
  reaper on the next tick (or by hand, see the audit issue). The code cannot
  tell which of the eight rows overlapped; read `gestart` / `found` per row.
- Verify the Opdrachtoverheid counters: the `bron` search facet is computed
  from the Manticore index, not from `curated.aanvraag`. A source with active
  rows in Postgres and zero in the facet means the projector has not indexed
  them; run the projection repair for that `bron_id` and compare counts.
- CTM and Flinter are inactive by the activation rule, not by a bug: their
  test imports yielded 6 and 19 distinct records against a minimum of 20
  (`de live-bronnenstatus van 2026-09-03 (intern, niet in deze repo)`). `activateBron` refuses
  them by design. Activating either needs a product decision to lower the
  threshold or an operator running a fresh test import that clears it; the
  code does not activate sources on its own.

## How the backlog drains

After a source's ingest pipeline finishes, the poller keeps calling
`curateScrapeRun` for that same source while the result's `remaining` count is
above zero and the run's `POLLER_CURATE_BUDGET_MS` has not run out. That is
what lets an accumulated backlog shrink over successive poll runs instead of
being cut off by a task timeout.

`remaining` counts every recoverable observation for the source, including rows
that nothing can advance right now (blocked ordering, missing raw payload). A
pass that fails to shrink `remaining` ends the drain for that source in that
run, so a permanently stuck row cannot spin the loop until the budget expires.

## Single instance via the advisory lock

The poller takes a Postgres session level advisory lock (`pg_try_advisory_lock`)
on startup and holds it for its lifetime, using the same primitives as the
projector (`packages/db/src/process-lock.ts`). A second instance started against
the same database does not exit. It polls for the lock every 2 seconds, writes
its heartbeat file on every poll so the Docker HEALTHCHECK keeps reporting
healthy, and logs one `poller_lock_waiting` line at most every 30 seconds. It
polls nothing until it holds the lock. Two pollers therefore never run at once,
which is what keeps a source from being polled twice concurrently.

The scoped liveness fiber re-asserts the lock periodically with a bounded
probe, not just at cycle boundaries. A lock dropped silently by idle connection
reaping or database autosuspend raises `LockLostError` and exits the process
rather than letting it poll on without ownership.

The lock key is an arbitrary constant, `ADVISORY_LOCK_KEY` in
`apps/worker/src/poller/main.ts`, deliberately different from the projector's in
`apps/server/src/projector/main.ts`. Advisory locks are keyed by the literal, not
by a name, so any third advisory lock added to this codebase needs its own
constant.

## Heartbeat and supervision

The poller has no HTTP surface, so process liveness is a file. Its scoped
liveness fiber writes the current epoch millis independently of source progress
and the Dockerfile HEALTHCHECK runs `bun src/poller/heartbeat.ts --check`.
The check reports healthy while that file is younger than
`MAX_POLLER_HEARTBEAT_AGE_MS`, 300 seconds. A separate bounded lock probe runs
every 10 seconds; a fresh heartbeat does not prove database readiness, lock
ownership or source freshness.

The `--check` entrypoint is a separate module from `main.ts` on purpose, so a
health check every 15 seconds does not boot the typed environment, the database
client and the connector registry.

Put the process under a supervisor. Docker Compose uses
`restart: unless-stopped` on the `poller` service; systemd wants
`Restart=on-failure`.

A rolling deploy works the same way it does for the projector. Coolify starts the
replacement container, which stays healthy while it waits for the lock, then
removes the outgoing one. SIGTERM cancels cancellable source I/O, drains
uncancellable persistence and the scoped liveness probes, releases the lock
and exits 0. The replacement acquires it on its next poll.

### Give shutdown enough time

Shutdown is cooperative, so the stop timeout has to cover it. On SIGTERM the
poller stops starting new sources immediately. Sources already running cancel
connector requests and waits, then drain any uncancellable persistence and
their curation boundary before the lock is released. Those sources run side by
side, so the wait is still one bounded source drain rather than
`POLLER_CONCURRENCY` of them in series: the same budget the heartbeat
and bounded probe teardown must fit within the stop grace, so the `poller` service in
`docker-compose.yml` keeps `stop_grace_period: 300s`.

Set the same 300 second stop timeout on the Coolify application. Coolify's
default is shorter, and a short timeout turns every deploy into a SIGKILL part
way through a source: the advisory lock then stays held until Postgres notices
the dead connection, and the replacement container sits logging
`poller_lock_waiting` instead of taking over.

## What to watch

- **`poller_source`**: one JSON line per source run, carrying `bronSlug`,
  `durationMs`, `found`, `curated`, `remaining` and, on failure, `errorName`
  plus `errorMessage`. `remaining` is the number to watch while the backlog
  drains: it should trend down run over run and settle near zero.
  `errorMessage` is the first 300 characters of the thrown `Error.message`
  joined with every `cause` message beneath it (up to four levels, separated by
  ` <- `), with any `postgres://` or `postgresql://` connection string replaced
  by `[redacted]`. `errorName` alone was not actionable: a production line read
  `{"errorName":"Error"}` for `harveynash` and said nothing about what failed.
  Neither was the outermost message alone: `Curation failed for observation
  7100e5cb-...` named the row but not the defect, which sat two `cause` links
  down as `index row size 3368 exceeds btree version 4 maximum 2704`.
- **Observations parked on `curation_failed`**: a single observation whose
  curation throws something the pass does not classify is no longer allowed to
  abort the pass. It is marked `staging.aanvraag_observation.status =
  'curation_failed'`, its identity is blocked for the rest of that pass so
  later observations of the same source record cannot be curated out of order,
  it is counted in the pass result as `failed`, and curation continues with the
  next identity. One line goes to stderr as
  `{"event":"curation_candidate_failed","observationId":...,"errorName":...,"causeChain":...}`
  with the first 500 characters of the chain. `curation_failed` is terminal: it
  is not in `RECOVERABLE_STATUSES`, so no later pass picks the row up again and
  it no longer counts toward `remaining`. Find them with
  `SELECT id, bron_id, source_record_id, created_at FROM staging.aanvraag_observation
  WHERE status = 'curation_failed' ORDER BY created_at;`, and join
  `staging.source_record` for the `bron_referentie` behind each one. There is no
  automatic retry by design: fix the underlying defect first, then re-queue the
  rows with `UPDATE staging.aanvraag_observation SET status = 'awaiting_curation'
  WHERE status = 'curation_failed' AND id = '...';`, or for a whole source once
  the defect is fixed for all of them,
  `UPDATE staging.aanvraag_observation SET status = 'awaiting_curation'
  WHERE status = 'curation_failed' AND bron_id = '...';`. The next poll for that
  source picks them up in `created_at` order like any other backlog. One caveat
  when the parked row was the identity's first observation: by the time you
  requeue it a later observation of the same source record has usually been
  curated already, so the requeued row classifies as `superseded` and the
  aanvraag starts at version two rather than one. That is expected, not a
  second defect. Before CTP-499 there was no such status: `curateScrapeRun` rethrew, so observation
  `7100e5cb-...` held 7,126 Harvey Nash observations from 9 September and every
  poll added one more.
- **`curation_raw_read_failed` is not the same thing.** An object store that
  will not answer is a storage problem, not a property of any row, so the pass
  writes no status at all: it aborts with a `RawReadError` and leaves every
  observation in the active status it already had. The next poll therefore
  retries the whole backlog with no operator action, which is the only outcome
  that is actually self-clearing. Parking the row would have needed a human to
  clear `curation_failed`, and deferring it would have needed a human to clear
  `deferred_missing_raw` (see `docs/runbooks/curation-recovery.md`), so neither
  is retried by the poller. `deferred_missing_raw` stays reserved for an object
  that is genuinely absent and has to be restored from the original capture. If
  you see a burst of `curation_raw_read_failed` lines, look at the object store,
  not at the observations.
- **A transient Postgres failure aborts the pass too.** `curateScrapeRun` walks
  the cause chain for a SQLSTATE and rethrows on classes `08` (connection),
  `40` (`40001` serialization, `40P01` deadlock), `53` (insufficient resources)
  and `57` (`57P01` admin shutdown, `57P02` crash shutdown, `57P03` cannot
  connect now). Curation takes `FOR UPDATE` on the source record while lifecycle
  reconciliation touches the same rows, so a deadlock is an ordinary outcome
  that a retry clears, and it must never burn a review status. Everything else
  parks: `54000` (the CTP-499 oversized index tuple), `22*` data exceptions,
  `23*` integrity violations.
- **A pass stops after five parkings.** Parking is for a row that is
  individually bad. A revoked grant or a half-applied deploy looks identical one
  row at a time, so the pass throws `TooManyParkedObservationsError` once five
  rows have parked rather than working through a whole backlog inside one poll
  budget. The rows already parked stay parked and the progress of the pass is
  kept; the next poll continues from there. Seeing this error means the failure
  is probably systemic: read the `curation_candidate_failed` lines before
  requeueing anything.
- **`poller_source_skipped`**: a due source was not polled. Today the only
  `reason` is `not_live`: production plus an unset live flag. One line per
  skipped source per evaluation, so a source that is meant to be live and keeps
  appearing here is a missing environment variable, not a broken connector.
- **`poller_cycle`**: one line per due-source evaluation with `pollable`,
  `due`, `skipped`, `inFlight` (runs still in flight) and `durationMs` (wall
  clock since the previous evaluation — roughly the tick, or less when a
  finishing run woke the loop early).
  An evaluation with `due: 0` is normal; that is what most look like once every
  source has run inside its interval.
- **`poller_runs_abandoned`**: the tick's maintenance closed runs left
  `running` by a dead
  process, with `count`. Written only when the count is above zero. One line
  after a crash or a hard kill is expected; a line every tick means runs are
  being abandoned as fast as they are opened, which is a poller that keeps
  dying rather than a repair that keeps working.
- **`poller_started`**: once per process, carrying the resolved tick, curate
  budget, concurrency and abandon threshold plus the release SHA, so a deploy
  can confirm which build is running with which knobs.
- **`poller_lock_waiting`**: expected for a few seconds during a rolling deploy.
  Sustained for minutes means the outgoing process never released the lock.
- **`poller_fatal`**: the loop exited. `LockLostError` means another session took
  the lock; anything else is a bug or an unreachable dependency. The supervisor
  restarts either way.

Logs never carry raw payloads or database URLs.

## Behaviour reference

| Condition | What happens |
|---|---|
| A source throws | Logged as one `poller_source` line with `errorName` and a redacted, 300 character `errorMessage`, skipped for this evaluation, retried on its own interval. The loop and the other sources in flight are unaffected. |
| A run is left `running` by a dead process | Failed on the next maintenance tick once it is older than `POLLER_ABANDON_RUN_AFTER_MS`, with the `unknown` / `internal` / `UNEXPECTED_FAILURE` tuple and `geindigd` set. Logged as one `poller_runs_abandoned` line with the count. |
| A run outlives `POLLER_RUN_BUDGET_MS`, or SIGTERM arrives mid-run | The run stops before its next item, keeps everything fetched so far, leaves the interrupted page's checkpoint where it started and closes the row as `succeeded` with `completeness.reason = "aborted"`. Missed-poll reconciliation skips staling for that run. Logged as one `poller_source_incomplete` line. |
| Database unreachable | The evaluation's candidate load throws out of the loop and the process exits 1 with `poller_fatal`. The supervisor restarts it. |
| `POLLER_DATABASE_URL` missing or a known pooler URL | Typed env validation fails before startup and the process exits non-zero. Supply the direct endpoint for the same database and role. |
| Second instance started | Waits for the advisory lock instead of exiting: polls every 2 s, keeps the heartbeat fresh so it stays healthy, logs `poller_lock_waiting` at most every 30 s, polls nothing. SIGINT or SIGTERM during the wait exits 0 without ever having held the lock. |
| Lock silently dropped | Caught by the scoped periodic bounded probe. If the lock is free the same session retakes it; if another session has it, `LockLostError` exits the process 1. |
| Backlog cannot shrink | The drain loop for that source ends as soon as a curation pass fails to reduce `remaining`, rather than burning the whole budget. The next poll run tries again. |
| A due source has no live flag in production | Skipped before its connector is built, logged as `poller_source_skipped` with `reason: "not_live"`. No scrape run, no fixture data in `curated`. |
| SIGINT / SIGTERM | Aborts the loop. The due sources not yet started are dropped; cancellable source requests and waits stop, while uncancellable persistence drains its current write boundary. Then a shutdown line, the lock release, the connection close, and exit 0 unless a process-level failure occurs. Source-level persistence or ownership failures are logged and do not necessarily change the process exit code. A repeated signal is logged as `poller_shutdown_in_progress` and otherwise ignored. This needs a stop timeout of at least 300 s on both Compose and Coolify; below that Docker escalates to SIGKILL, which nothing in userspace can catch and which can leave the advisory lock held until Postgres notices the dead connection. |

## Related work

- Search outbox draining, and why it is a separate process:
  [search-projector.md](search-projector.md).
- Deployment inventory and the service table:
  [hetzner-deploy.md](hetzner-deploy.md).
- Raw payload storage and the production guard:
  [raw-object-storage.md](raw-object-storage.md).
