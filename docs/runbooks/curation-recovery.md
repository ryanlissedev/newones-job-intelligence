# Curation recovery

The poll worker drains durable observations after a connector run succeeds.
Curation is therefore retryable independently of connector execution: invoking
the same task payload for an already-succeeded `bronId`, `scrapeRunId`, and
`runKind` reads the persisted run and drains the source's curation backlog
without starting the connector again. A later successful poll also drains
eligible observations left by earlier runs.

## Safety model

New observations use `awaiting_curation`. When they are newer than the
committed high-water, they follow the normal normalisation path, including
same-content updates to `laatst_gezien_op`, lifecycle status, location, and
deadline. Historical rows with the old
`pending` default are classified before their raw object is read:

- an exact identity, run, content hash, and raw reference already present in
  current or versioned curated data is marked `already_committed`;
- legacy same-content work proven no newer than the current `laatst_gezien_op`
  is marked `unchanged` without rewriting lifecycle fields;
- a row demonstrably older than the current curated pointer is marked
  `superseded`;
- a newer row is normalised and curated;
- an ambiguous or invalid pointer is marked `blocked_ordering` for operator
  review rather than rewinding current data.

Derived recovery markers retain origin. Fresh rows use
`deferred_missing_raw` or `blocked_ordering`; legacy rows use
`deferred_missing_raw_legacy` or `blocked_ordering_legacy`. This prevents a
legacy row from silently switching to fresh-row classification on retry.

Only observations attached to `succeeded` runs are eligible. The task's own
run kind is fenced before recovery starts, while its source-wide backlog may
include earlier successful test or poll observations. This includes
a succeeded connector run whose listing was incomplete;
the missed-poll lifecycle remains skipped, while its persisted observations are
still safe to curate. Rows from running, failed, or cancelled runs remain
untouched. A missing raw object receives a durable deferred marker, remains in
`remaining`, and appears in the task's `pending` count. Deferred missing-raw
rows are not automatically selected again, so they cannot permanently consume
a bounded batch ahead of ready work. A missing object or known ordering blocker
for one identity blocks later observations for that identity, while other
identities continue. An unexpected normalisation or database failure aborts
the task with the observation ID so the task retry retains diagnostics.

An `unchanged` observation is superseded only when it is provably a no-op
refresh: the canonical record is already `active` on the same `content_hash`,
and a strictly later succeeded run holds an observation of the same source
record with that hash whose payload passes the same full
observation-contract check candidate selection applies and which already
applied. A sibling that has not applied yet — awaiting, ordering-blocked,
or pending — proves nothing: it may still fail or defer when attempted.
Such a will-apply sibling (with a readable raw object) only suppresses its
predecessors from that pass's candidacy, so they consume no attempt slots
while staying recoverable; the pass marks them `superseded` in a second
bounded sweep after processing, solely when a dominator actually applied.
A dominator that fails, defers on missing raw, or stays blocked marks
nothing, so the suppressed rows resume as ordinary candidates next pass.
Rows that could still write a lifecycle transition — the canonical
record is `stale` or `closed`, or the hash differs — are never dominated,
and neither are rows whose only later siblings sit on `curation_failed`, a
missing-raw deferral, `quarantined`, or `superseded`, because those siblings
either need an operator or cannot stand in for the earlier row. Each sweep
marks dominated rows `superseded` in one bounded statement (up to 5,000
rows) before candidate selection and again after it. The row stays in the
table for history; it is not deleted and no canonical data is rewritten.

Each invocation attempts at most 100 observations by default (configurable by
the internal caller from 1 through 500). It returns a bounded attempted-ID list,
a true remaining-backlog count, and cause counts for curated, unchanged,
pending, quarantined, already committed, superseded, and ordering-blocked rows.
Every identity is processed oldest-first. The source-record lock, curated/SCD2 and
outbox writes, and observation terminal marker commit in one transaction.
Identities are ranked by their earliest recoverable `created_at` — up to the
attempt limit, plus up to the attempt limit more observed in the current
run — and each selected identity contributes its chain in pointer order (run
start, `observedAt`, run id, hash, raw ref), so a deep backlog cannot push
one identity's head outside the scan window while its current-run rows are
attempted out of order. `observedAt` is ordered as stored text rather than
cast, so a malformed timestamp reaches the blocking classification path
instead of aborting candidate selection.

## Retry and reconcile

1. Reinvoke the original poll task with exactly the same bron, run ID, slug,
   and run kind. A mismatch is rejected before connector or curation work.
2. Repeat while `remaining` decreases. Stop when it reaches zero. Stop
   automatic retries when a batch makes no terminal progress and reports only
   `pending` or `blockedOrdering`; resolve that cause before retrying.
3. If `pending` is non-zero, start with the bounded `attemptedObservationIds`
   from the invocation that discovered the missing object. Query deferred rows
   by status when reconciling an older batch, and verify that every referenced
   raw object exists in the configured durable object store.
   Restore the missing object from the original immutable capture. Requeue only
   the reviewed IDs by changing `deferred_missing_raw` back to
   `awaiting_curation`, or `deferred_missing_raw_legacy` back to `pending`, then
   retry. The origin-specific mapping is required.

   ```sql
   SELECT o.id, o.status,
          o.payload->>'rawPayloadRef' AS raw_payload_ref
   FROM staging.aanvraag_observation AS o
   JOIN curated.scrape_run AS r ON r.id = o.scrape_run_id
   WHERE o.bron_id = $1::uuid
     AND r.status = 'succeeded'
     AND o.status IN (
       'deferred_missing_raw',
       'deferred_missing_raw_legacy'
     )
   ORDER BY r.gestart, o.created_at, o.id;
   ```

   ```sql
   UPDATE staging.aanvraag_observation
   SET status = CASE status
     WHEN 'deferred_missing_raw' THEN 'awaiting_curation'
     WHEN 'deferred_missing_raw_legacy' THEN 'pending'
   END
   WHERE id = ANY($1::uuid[])
     AND status IN ('deferred_missing_raw', 'deferred_missing_raw_legacy')
   RETURNING id, status;
   ```

4. When a backlog grows faster than the bounded pass drains it, diagnose its
   composition before any repair. The report categorizes recoverable rows into
   missing raw, parse-invalid, ordering-blocked, `curation_failed`, dominated
   `unchanged` duplicates, and actionable work; it is read-only:

   ```bash
   DATABASE_URL=... bun tools/backfill/curation-backlog-repair.ts \
     --bron <bron-uuid>
   ```

   Dominated duplicates are the only category the tool mutates, and only with
   an explicit quiesced apply bounded by `--limit`. The update is identical to
   the runtime dominated sweep and idempotent; rerun until
   `remainingDominated` is zero. The printed JSON is the audit receipt —
   redirect it to a file for the release record:

   ```bash
   DATABASE_URL=... bun tools/backfill/curation-backlog-repair.ts \
     --bron <bron-uuid> --apply --ingest-quiesced --limit 5000 \
     > repair-receipt-$(date -u +%Y%m%dT%H%M%SZ).json
   ```

   Do not requeue `curation_failed` rows or mass-update statuses through this
   path; those categories need a separately reviewed repair plan.

5. Review `blocked_ordering` and `blocked_ordering_legacy` rows manually. Do not
   change them back to an active status until the source identity, observation
   time, run start, hash, and raw reference establish a unique order.
   Use this read-only query for the reported IDs:

   ```sql
   SELECT o.id, o.status, o.bron_id, o.scrape_run_id, r.run_kind,
          r.status AS run_status, r.gestart, o.source_record_id,
          o.content_hash, o.payload->>'observedAt' AS observed_at,
          o.payload->>'rawPayloadRef' AS raw_payload_ref
   FROM staging.aanvraag_observation AS o
   JOIN curated.scrape_run AS r ON r.id = o.scrape_run_id
   WHERE o.id = ANY($1::uuid[])
   ORDER BY r.gestart, observed_at, o.id;
   ```
6. After the backlog is empty, let the normal outbox projector drain. Use the
   projection repair runbook only when its reconciliation reports a search
   divergence; curation retry itself must not synthesize duplicate outbox
   events.

This path does not repair arbitrary historical data and never curates a failed,
cancelled, or still-running connector run. Recovery that needs a raw-object rewrite or an
ordering override requires a separately reviewed repair plan.
