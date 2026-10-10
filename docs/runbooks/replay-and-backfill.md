# Replay and backfill

Operator entry point for re-running a chosen bron's ingest without duplicating data or
downstream effects (RJC-343 / JI-036). This covers `bun run replay:run`, the
`replayBron` use-case behind it, and how replay relates to the Motian Neon backfill
and to data retention.

## When to replay

Use replay when you need to re-run a bron's ingest against a known input — a captured
fixture, or (once implemented) a previously recorded run — without waiting for the
next scheduled poll and without risking duplicate canonical rows. Typical cases:
verifying a connector change against a known payload, reproducing a curation bug from
a specific input, or proving the ingest path is idempotent before a release.

Replay always runs through the exact same path a live poll uses:
`executeBronRun` (`packages/application/src/bronnen/execute.ts`) →
`runConnector` (`packages/connectors/src/run.ts`). It uses `runKind: "test"`, so the
target bron only needs `voorwaardenStatus: "toegestaan"` — it does not need to be
`actief`.

## Replay a bron from a fixture

```bash
bun run replay:run -- --bron tenderned --fixture fixtures/connectors/tenderned/listing-page-0.json --dry-run --json
```

- `--bron <tenderned|inhuurdesk>` — which Slice A bron to replay. The CLI resolves
  this to the seeded bron id from a small local table in `scripts/replay-run.ts`
  (mirrors `apps/worker/src/slice-a-bronnen.ts`, which is not importable from a root
  script — that app package has no `exports` field).
- `--fixture <path>` — a `connector-fixture/v1` envelope under `fixtures/connectors/`.
  A leading `fixtures/connectors/` prefix is stripped automatically, so either
  `tenderned/listing-page-0.json` or the full repo-relative path works.
- `--dry-run` — force in-memory stores even if `DATABASE_URL` is set. Without
  `--dry-run` and with `DATABASE_URL` set, replay writes through the real Postgres
  stores and the filesystem object store, exactly like a live poll.
- `--json` — print the `ReplaySummary` as JSON instead of a one-line human summary.
- `--repeat <n>` — run `n` replay passes against one shared runtime (default `1`).
  See "Proving no duplication" below — this is the flag that turns replay into a
  one-command duplication check.

Under the hood, `replayBron` (`packages/application/src/replay/replay.ts`) builds a
connector for the given bron using the same fixture-backed client the connector
already supports for CI (`createTenderNedClient({ liveEnabled: false, ... })` /
`createInhuurdeskClient({ liveEnabled: false, ... })`), overriding only
`listingFixturePath`. No new fixture-loading code was added — this reuses
`packages/connectors/src/fixtures/load.ts` via the existing client options.

## Replay a recorded run

**Not implemented.** The `ReplaySource` union includes
`{ kind: "object-store"; runId: string }`, and `replayBron` throws a clear
"not implemented" error for it rather than guessing. Reason: replaying a past run
from the object store requires enumerating that run's stored raw payloads
(`rawPayloadRef` + `bronReferentie` + `contentHash` per `ConnectorObservation`), and
no port in `packages/connectors` exposes that as a read query — `ObservationRecorder`
is write-only from the application layer (`record()` only), and `ObjectStore` only
supports `get(path)` for a single known key, not listing by `scrapeRunId`. The only
place that currently queries observations by `scrapeRunId` is a direct Drizzle query
inside `packages/db/src/curate-scrape-run.ts`. Adding object-store replay properly
means adding a read port for "observations by scrapeRunId" to
`packages/connectors`, not reaching into `@ji/db` internals from the CLI or from
`replayBron`. That is future work, not part of this change.

## Proving no duplication

**Primary operator proof — one command, `--repeat`:**

```bash
bun run replay:run -- --bron tenderned --fixture fixtures/connectors/tenderned/listing-page-0.json --dry-run --repeat 2 --json
```

`--repeat <n>` (default `1`) runs `n` replay passes against **one shared runtime** —
the same `persistence`/`objectStore`/`observationRecorder`/`runLifecycleStore` for
every pass, closed once at the end. Each pass gets its own `runId`, but the second
pass sees the first pass's state, which is exactly what makes this a real
duplication check instead of two independent fresh runs. With `--json` the CLI
prints an array of summaries, one per pass; without it, one line per pass. If any
pass after the first still reports `created > 0` — the duplication signal — the
process exits non-zero with an explanatory line on stderr.

This is the actual output from running that exact command:

```json
[
  {
    "bronId": "00000000-0000-4000-8000-000000000001",
    "created": 1,
    "dryRun": true,
    "durationMs": 16,
    "observed": 1,
    "rejected": 0,
    "runId": "43ccfb32-36c8-4c42-9f09-0cce6a56d3a0",
    "source": { "kind": "fixture", "path": "tenderned/listing-page-0.json" },
    "unchanged": 0,
    "updated": 0
  },
  {
    "bronId": "00000000-0000-4000-8000-000000000001",
    "created": 0,
    "dryRun": true,
    "durationMs": 19,
    "observed": 1,
    "rejected": 0,
    "runId": "4c2df4ef-48c7-484f-9d69-7006e246c48f",
    "source": { "kind": "fixture", "path": "tenderned/listing-page-0.json" },
    "unchanged": 1,
    "updated": 0
  }
]
```

Exit code `0`. The first pass creates the canonical row (`created: 1`); the second
pass observes the same content and the observation recorder classifies it
`"unchanged"` (`created: 0, unchanged: 1`) — no duplicate row. `runId` differs per
pass by design (each pass is its own connector run through the ingest lifecycle);
everything else about the input is identical.

**Deployment-level proof:** the same command, without `--dry-run` and with
`DATABASE_URL` pointed at a real Postgres (see `docs/runbooks/postgres-on-box.md`),
is the proof that matters for a live deployment — it shows the same `created: 1`
then `created: 0` pattern, but through the real Postgres-backed observation
recorder rather than an in-memory one scoped to a single CLI process.

**Hazard: replaying stale content against a live DB moves the canonical pointer
forward, even though `created: 0` still holds.** `PostgresObservationRecorder`
picks which observation is "canonical" for a `(bronId, bronReferentie)` via
`compareSourcePointerOrder` in `packages/db/src/bron-runtime.ts` (~line 617),
which ranks candidates by the owning run's `startedAt` **first**, then observed
time, then `scrapeRunId`, then `contentHash`. A replay run always starts *now*.
So if you replay a fixture whose `contentHash` differs from the row currently in
`staging.source_record` (a stale fixture, or one built from a different point in
time than the live bron's current state), the observation recorder classifies it
`"changed"` — not `"new"` — and rewrites `source_record.{contentHash,
rawPayloadRef, scrapeRunId}` to the fixture's older content, timestamped ahead of
the last real live poll. `--repeat` does not catch this: idempotence
(`created: 0` on later passes) still holds, because the second pass replays the
same fixture against the pointer the first pass just wrote — the corruption
already happened on pass one, before `--repeat` had anything to compare against.
Only replay against a real `DATABASE_URL` with a fixture captured from that
deployment's *current* state, or go in knowing you are deliberately moving the
pointer. When you just want to check ingest behavior rather than touch a
deployment's canonical state, `--dry-run` is the safe default — it never gets
near this table.

**Spec-level proof:** `packages/application/src/replay/replay.spec.ts` replays the
same tenderned fixture twice through *shared* in-memory stores in one process and
asserts the second summary has `created: 0`, `unchanged: 1`, and that the
observation recorder still holds exactly one canonical record. This is the
mechanism underlying both proofs above: the observation recorder classifies a
fetch with an unchanged `contentHash` for the same `(bronId, bronReferentie)` as
`"unchanged"`, not `"new"` — replay never inserts a second row for identical
content.

A single CLI invocation without `--repeat` (or two *separate* process invocations)
does **not** demonstrate this: `--dry-run` (and any run with `DATABASE_URL` unset)
uses `InMemoryObjectStore` / `InMemoryObservationRecorder` /
`InMemoryRunLifecycleStore`, scoped to that one process's runtime. Two separate
`bun run` invocations each start a fresh, empty in-memory runtime and would each
report `created: 1` — that is a correct result for what was actually run (two
independent processes with no shared state), it just isn't a duplication proof.
`--repeat` exists specifically to close that gap in a single command.

## Re-running the Motian-Neon v1 backfill

Replay (this runbook) and the Motian-Neon v1 backfill are separate tools for
separate inputs — replay re-runs a live-poll-shaped bron against a fixture or run,
the backfill imports historical Motian rows. See
[motian-neon-backfill.md](./motian-neon-backfill.md) for `bun run backfill:neon-v1`,
platform coverage, and how backfilled rows reach search via the outbox drain.

## Retention & deletion — current state and gap

Retention purge is **out of scope for replay** (blocked on DEC-008 / RJC-324). What
exists today:

- Every bron row has a `retention_days` column (`packages/db/src/schema/curated.ts`),
  `NOT NULL DEFAULT 90`, with a check constraint (`retention_days > 0`).
- `retentionDays` only controls the `expiresAt` written onto each raw object in the
  object store (`ExecuteBronRunInput` → `runConnector` → `objectStore.put`). It does
  **not** currently drive any scheduled deletion: there is no purge job that reads
  `expiresAt` and removes expired objects, and `ObjectStore.deleteExpired(before)`
  exists as a method on the interface but nothing calls it on a schedule today.
- There is no propagation of deletion to derived stores. In particular,
  `packages/search/src/projector.ts` only calls `engine.deleteDocument(...)` in
  response to an explicit outbox delete event from curation — it has no path that
  reacts to raw-object expiry or to a retention purge, because no purge job exists to
  emit that event.

Net: retention today is a data point recorded per bron, not an enforced lifecycle.
Building the purge job and its propagation to search is DEC-008 / RJC-324 territory,
not this ticket.

## Rollback notes

Replay never mutates code paths or schema — it only calls the existing
`executeBronRun` with `runKind: "test"` against either in-memory stores or the real
Postgres/filesystem stores you already run live polls against. There is nothing to
roll back structurally.

Replay calls `executeBronRun` only — it never calls `curateScrapeRun` or the outbox
drain (compare the full `executeBronRun → curateScrapeRun → drainPostgresOutbox`
pipeline in `apps/worker/src/poll-bron-run.ts:157-187`, which live poll runs but
replay does not). A DB-mode replay run (`DATABASE_URL` set, no `--dry-run`) therefore
only ever writes:

- a `curated.scrape_run` row (the run's lifecycle record),
- rows in `staging.source_record` and `staging.aanvraag_observation`,
- raw payload objects on disk under the object store.

It never creates `curated.aanvraag` rows and never touches search projections —
those only exist once curation and the outbox drain run, and replay stops short of
both. If a replay run against real stores produced unwanted staging rows (for
example, a fixture with the wrong `bronReferentie`s), remove the affected rows from
`staging.source_record` / `staging.aanvraag_observation` and the corresponding
`curated.scrape_run` row directly — there is no curated or search state to clean up
from replay alone.
