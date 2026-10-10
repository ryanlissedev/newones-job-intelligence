# Search projector (RJC-387)

## Why this exists

Before this change, a worker run chained poll → raw → normalise → curate →
outbox → Manticore in one call chain: `apps/worker/src/poll-bron-run.ts`
constructed a `ManticoreSearchEngine` and called `drainPostgresOutbox` right
after the outbox commit, in the same process, in the same call. Two
problems followed from that:

- Source ingest failed whenever Manticore was unreachable, even though
  ingest and search are logically independent.
- The cloud worker (Trigger.dev) needed network access to Manticore, which
  [ADR-0006](../adr/ADR-0006-neon-as-system-of-record.md) keeps on a private
  port (it moved the database itself off private-port isolation onto
  Neon's TLS-required public endpoint, but explicitly left Manticore's
  reachability question open, naming "run the drain on-box" as one of the
  resolutions — this ticket implements that resolution).

The fix: the worker stops after the outbox commit, and a small
long-running **on-box projector process**, deployed next to Manticore,
reads the Neon outbox over TLS and writes to Manticore locally. Manticore
stays private, ingest is decoupled from search uptime, and a stalled or
crashed projector can always recover by resuming from the durable
`curated.search_projection_checkpoint` — the outbox is Neon, not something
the projector owns.

## Deploy contract

Production is expected to run in **onbox** mode. This is the two-sided
contract that changes:

| Component | Setting |
|---|---|
| Worker (Trigger.dev) | `SEARCH_PROJECTOR=onbox`, no `MANTICORE_URL` |
| Projector process | Runs on the Manticore host. Pooled `DATABASE_URL` for data queries + direct `PROJECTOR_DATABASE_URL` for the session lock (same Neon branch/database and app role) + `MANTICORE_URL=http://127.0.0.1:9308` |

Nothing changes until `SEARCH_PROJECTOR=onbox` is set on the worker: the
default mode is `"worker"`, which preserves today's behaviour exactly (the
worker drains inline, as it always has). Flip the worker to onbox mode and
start the projector process together — not one without the other, or ingest
will succeed while the outbox backs up unread (worker in onbox mode with no
projector running) or the worker will still demand `MANTICORE_URL` it
doesn't have (projector running, worker left in worker mode with no
Manticore route).

### Running the projector

```bash
bun run projector   # apps/server: bun src/projector/main.ts
```

Reads its typed environment via `@ji/env/projector`. `DATABASE_URL` may use
Neon's pooled TLS endpoint for ordinary data queries. `PROJECTOR_DATABASE_URL`
must use the direct endpoint for the same Neon branch/database and role; the
process rejects known `*-pooler.*.neon.tech` and `*.pooler.*.neon.tech` hosts
before opening the lock connection. `MANTICORE_URL` is also required.

### Supervision

The projector is a single long-running process with no built-in restart
loop — put it under a supervisor:

- **systemd**: a service unit with `Restart=on-failure` covers both a crash
  (transient error escaped the loop's own backoff — shouldn't happen, but
  the supervisor is the backstop) and a schema-mismatch exit (see below;
  restarting won't fix that one, but it's the same unit either way).
- **Docker Compose**: `restart: unless-stopped` (see the `projector` service
  in `docker-compose.yml`, gated behind `--profile projector`).

### Single instance via the advisory lock

The projector takes a Postgres session-level advisory lock
(`pg_try_advisory_lock`) on startup and holds it for its lifetime. A second
instance started against the same database does not exit. It polls for the
lock every 2 seconds, writes the heartbeat file on every poll so the Docker
HEALTHCHECK keeps reporting healthy, and logs one `projector_lock_waiting`
line at most every 30 seconds. It drains nothing until it holds the lock. It
means:

- A supervisor restarting a still-running instance (e.g. a flapping health
  check) never causes two projectors to double-drain.
- Deploying a new version alongside an old one draining the same outbox is
  safe: the new one waits out the old one's exit, never runs concurrently.

### Rolling deploy handoff

This is what lets a Coolify rolling update work without an operator stopping
the projector first. Coolify starts the replacement container, waits for it to
report healthy, then removes the outgoing one. The replacement reports healthy
while it waits, because waiting is what keeps its heartbeat file fresh.
Removing the outgoing container sends it SIGTERM, its shutdown path finishes
the in-flight cycle and releases the lock, and the replacement acquires it on
its next poll.

A stop through Coolify still removes the container, so a deliberate stop stays
a stop and is not a handoff. SIGINT or SIGTERM during the wait aborts the wait
and exits 0 without the container ever having held the lock.

For a few seconds between "healthy" and "holding the lock", `/projector/runtime`
still reports the outgoing container and release SHA, or answers 503 with
reason `runtime_missing` or `heartbeat_stale`. The deploy driver
(`scripts/production/coolify-deploy.ts`) re-reads that endpoint every 5 seconds
for up to 90 seconds before failing, so that gap is expected rather than a
failed deploy.

The lock is re-asserted every cycle, not just taken once at startup: a lost
lock (idle-connection reaping, Neon autosuspend) exits the process instead
of silently draining without it — it never double-drains.

Do not point `PROJECTOR_DATABASE_URL` at Neon's pooler. Session-level locks
belong to one backend session, while a pooler may route later queries to a
different session. The dedicated variable makes this constraint independent
from `DATABASE_URL`: API/projector data traffic may stay pooled without
weakening singleton ownership.

The Trigger.dev `drain-outbox` task follows the same ownership contract. With
`SEARCH_PROJECTOR=onbox` it returns an explicit `deferred: true` result without
opening Postgres or requiring `MANTICORE_URL`; only the on-box process drains.

The lock key is an arbitrary constant (`ADVISORY_LOCK_KEY` in
`apps/server/src/projector/main.ts`) — see the comment there before adding
a second advisory lock anywhere in this codebase, so the two never collide.

### What to watch

- **Cycle logs**: one structured JSON line per drain cycle
  (`{"event":"projector_cycle","drained":N,"indexVersion":N,"durationMs":N}`,
  or with `"errorName"` set on a failed cycle). Drained rows should track
  ingest volume; a `drained: 0` cycle every ~1s is normal at idle.
- **Outbox lag**: not yet wired to a metric — that's RJC-391. Until then,
  the operator signal is `curated.search_projection_checkpoint.appliedSequence`
  falling behind `curated.outbox_event`'s max `sequence_number`.
- **`errorName` in a cycle log**: a transient failure (Manticore or Neon
  unreachable) backs off exponentially and keeps retrying — see behaviour
  table below. It does not need paging on its own; page on sustained lag.

The projector has no HTTP surface of its own, so it publishes its identity to
`curated.search_projector_runtime` and the API server serves that row at
`GET /projector/runtime`. The response carries `indexName`, `releaseSha`,
`active`, `containerId`, `cycle`, `startedAt`, `heartbeatAt`, `heartbeatAgeMs`
and `heartbeatFresh`. A heartbeat counts as fresh for 60 seconds, the same
window the Docker HEALTHCHECK uses. The endpoint answers 200 only when the row
exists and is fresh; a missing row, a stale heartbeat or a failed read all
answer 503 with `active: false` and a `reason` field, so a deploy that only
checks the status code cannot mistake a dead projector for a live one. The
projector writes the row at most once every 15 seconds, so `cycle` advances in
steps rather than once per poll.

## Behaviour reference

| Condition | What happens |
|---|---|
| Manticore down | Each drain cycle throws; the loop logs the error, backs off (starts at 1s, doubles, caps at 30s), and keeps retrying. Never exits on its own. |
| Neon data endpoint (`DATABASE_URL`) down | Same as Manticore down — the drain call fails, same backoff-and-retry. |
| Neon direct lock endpoint (`PROJECTOR_DATABASE_URL`) missing or a known pooler URL | Typed env validation fails before startup; the process exits non-zero. Supply the direct endpoint for the same branch/database. |
| Schema mismatch (`SearchIndexSchemaMismatchError`) | Not retried. This means the index was built for a different document mapping than the running code expects — an operator action (start a new generation via `tools/manticore/start-search-generation.ts` and reindex), not something a retry can fix. The loop rejects and `main.ts` exits 1. Fix the mismatch, then let the supervisor restart it (or restart manually). |
| Second instance started | Waits for the advisory lock instead of exiting: polls every 2 s, keeps the heartbeat file fresh so it stays healthy, logs `projector_lock_waiting` at most every 30 s, drains nothing. It acquires as soon as the current holder releases. SIGINT/SIGTERM during the wait exits 0 without ever having held the lock. |
| Lock silently dropped (idle-connection reaping, Neon autosuspend) | Caught by the every-cycle heartbeat, not by luck: if the lock is still free, the same session retakes it and the cycle proceeds; if another session already grabbed it, the heartbeat throws `LockLostError`, which is not retried — the loop rejects and `main.ts` exits 1. Supervisor restarts it. |
| SIGINT / SIGTERM | Aborts the loop; an in-flight drain cycle always finishes first (never killed mid-cycle); logs a shutdown line; releases the advisory lock; closes the database connection; exits 0. A repeated SIGINT/SIGTERM (impatient supervisor, a `docker stop` retry, a second Ctrl-C) is logged as `projector_shutdown_in_progress` and otherwise ignored — it does not re-abort or kill mid-write. SIGKILL remains the only hard stop; nothing in userspace can catch it, so a SIGKILL mid-cycle can leave the advisory lock held until Postgres notices the dead connection. |

## Related work

- Outbox lag / readiness metrics: RJC-391 (not yet wired here).
- Bulk drain internals (`drainPostgresOutbox`, the xmin gate, checkpoint
  semantics): RJC-389 and RJC-384; this runbook only covers the process
  that calls it, not the drain algorithm itself — see
  `packages/db/src/outbox-drain.ts` for that.
