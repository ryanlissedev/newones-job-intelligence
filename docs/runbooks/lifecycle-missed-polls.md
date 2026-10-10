# Lifecycle: missed polls and listing disappearance (RJC-397)

Sources without a published closing date (Hero, Flinter, Inhuurdesk, ...) never
say "closed". The only signal that an aanvraag is gone is that the source's
listing stopped showing it. This runbook covers how that signal is counted,
when it closes a record, and what an operator sees.

## Mechanism

After every **poll** run of a bron, `executeBronRun` calls
`reconcileMissedPolls` (`packages/application/src/lifecycle/`) with the set of
`bron_referentie`s the listing showed this run (`observedBronReferenties` on
the connector run result: every discovered item, including rejected ones and
items skipped by the known-hash short-circuit).

| Record was ...            | Run complete | Run incomplete           |
| ------------------------- | ------------ | ------------------------ |
| in the listing            | `missed_polls = 0`, `last_seen_*` updated | same |
| not in the listing        | `missed_polls += 1` (saturates at threshold + 1) | untouched |

`staging.source_record.missed_polls` is the counter; `last_seen_scrape_run_id`
and `last_seen_at` record the last complete listing that showed the record.
Rows older than migration 0009 start at 0 with `last_seen_*` null. The
counter saturates at threshold + 1: a row sitting at the threshold whose stale
write was interrupted gets exactly one more bump and a second chance to
transition on the next complete run. `last_missed_scrape_run_id` records the
run that last bumped a row; the increment skips rows already bumped by the
same `scrape_run_id`, so a retried task or manual re-invoke of one run cannot
double-count.

A record whose counter reaches `DEFAULT_MISSED_POLLS_BEFORE_STALE` (3, in
`@ji/domain`) and whose aanvraag is still `active`/`unknown` becomes
**`stale`**. The transition is written through the same path a content change
uses: the open `aanvraag_versie` row is closed, a new version with the new
status is inserted, and an `outbox_event` of type `aanvraag.status_gewijzigd`
is written with payload `{ status: "stale", reden: "listing_verdwenen",
missed_polls, scrape_run_id }`. The search projector (RJC-389) applies the
payload status, so search reflects it on the next drain.

A `stale` record that shows up in a later complete listing goes back to
`active` the same way (`reden: "listing_teruggekeerd"`). A `closed` record
(closed by the source or its closing date, RJC-377) stays `closed`: being
observed resets its counter, never its status.

The counter reset and every resulting reopen write share one database
transaction (RJC-434). The transaction locks the bron before reading its
source records, so two reconciles for the same bron cannot interleave.
Observed `source_record` rows are then locked before their old counter decides
whether they reappeared. A failure while closing the old SCD2 version,
updating status, inserting the new version, or writing the outbox event rolls
the counter reset and the whole transition back. The next unchanged complete
listing therefore sees the stale counter again and retries the reopen.
The canonical database lock order is `bron` (no-key update), sorted
`source_record` rows, then `aanvraag`/SCD2/outbox. Keep curation and recovery
paths in that order when they share these rows.

Test-import runs never count misses. Replays run as test imports.

## Completeness

Only a run that saw the whole listing may count misses. The runner reports
two completeness values on its result:

- `completeness` says whether every listed item was also **fetched**. It
  drives the run's `completion` (`budget_exhausted`, `aborted`, …).
- `discoveryCompleteness` says whether the whole **listing** was discovered,
  however many detail pages were fetched. Closure keys on this one: every
  listed `bron_referentie` is counted as observed the moment discovery returns
  it, so a run whose budget ran out while fetching the last page still knows
  exactly which records are gone (scrape-architecture PR7).

Both share the reasons below; `discoveryCompleteness` is `aborted` only when
the cut landed before the last page was discovered.

- `{ complete: true }` -- fresh run, connector exhausted the listing.
- `{ complete: false, reason: "resumed" }` -- resumed from a checkpoint; earlier
  pages were seen by another attempt. A resumed run never increments, and it
  only resets the records THIS attempt observed: records seen only by the
  earlier attempt keep their prior count until the next complete run. That
  cannot stale anything early, because increments require a complete run.
- `{ complete: false, reason: "truncated" }` -- connector set
  `ConnectorDiscoverResult.truncated` (a page cap such as `STRIIVE_MAX_PAGES`).
- `{ complete: false, reason: "empty" }` -- the listing showed zero items.
  `executeBronRun` applies this guard: a zero-item listing is far more often a
  parser regression than an emptied bron, and the two are indistinguishable
  at the run boundary, so it never counts. A genuinely emptied bron keeps its
  last records `active` until a date or operator close (rare, accepted).

A failed run throws before the reconcile step, so it never counts. The run
result carries `lifecycle.skippedIncrementReason` when increments were skipped;
the on-box poller's `poller_source` log line (`docs/runbooks/onbox-poller.md`) mirrors it as a JSON-safe `lifecycle`
summary (`incremented`, `reset`, `staled`, `reopened`, `skippedIncrementReason`).

The four capped connectors (`striive`, `opdrachtoverheid`, `harveynash`,
`needstaffing`) set `truncated` when their page cap stops the walk while the
source still reported more. `ctm`, `flinter`, `inhuurdesk`, `json-ld`,
`onefellow` and `tenderned` have no cap: they walk until the source is
exhausted, so `truncated` is honestly absent there.

## Accepted degradations

- **Reconcile failure after a terminal run.** The scrape_run is marked
  `succeeded` before reconcile starts. If reconcile throws, the task fails, and
  a retry cannot re-run the same run id (the run store rejects a terminal run).
  Consequence: that poll's misses are simply not counted -- one poll of slack,
  nothing corrupted; the next complete run counts as usual. An operator sees a
  failed poll (a `poller_source` line with `errorName`) that has no `lifecycle` summary.
- ~~Status write and outbox row are separate statements.~~ Closed by RJC-399:
  the SCD2/status write and the outbox insert run in one Postgres transaction
  (`CurateStore.withTransaction`), in both `curateObservation` and this
  reconcile step. Rows that diverged before the fix do not self-heal (a later
  same-content event is skipped by the projection hash) — repair them with
  `bun run search:reconcile-projection` (see
  [projection-repair.md](projection-repair.md)). Still open:
  `curateObservation`'s unchanged-content branch writes a status change with
  no outbox event when the content hash is equal, so such a status flip
  diverges the index the same way; the repair tool is also the remedy there.
- ~~Counter reset can commit before a reopen status write.~~ Closed by RJC-434:
  reset, SCD2 version, status and outbox now commit in the same per-bron
  transaction. A failed reopen remains `stale` with its previous counter and
  retries on the next unchanged complete listing. Source- or date-closed
  records remain `closed`.

## Operator checks

Which records of a bron are on their way out:

```sql
SELECT bron_referentie, missed_polls, last_seen_at
FROM staging.source_record
WHERE bron_id = '<bron uuid>' AND missed_polls > 0
ORDER BY missed_polls DESC, last_seen_at;
```

What the reconcile step closed or reopened recently:

```sql
SELECT created_at, aggregate_id, payload->>'status' AS status, payload->>'reden' AS reden
FROM curated.outbox_event
WHERE event_type = 'aanvraag.status_gewijzigd'
ORDER BY sequence_number DESC
LIMIT 50;
```

A whole bron going stale at once after a run that reported zero items is a
connector regression, not a listing change: check the run's `aantal_gevonden`
and the source-silence alert (`docs/runbooks/source-silence.md`) before
reopening anything. Reopening happens by itself on the next complete run that
lists the records again.

## Related code

- Derivation and reasons: `packages/domain/src/lifecycle.ts`
- Reconcile step: `packages/application/src/lifecycle/reconcile-missed-polls.ts`
- Run boundary: `packages/application/src/bronnen/execute.ts` (`lifecycle` port),
  wired by `apps/worker/src/poll-bron-run.ts` from `createBronRuntimeClient().lifecycle`
- Completeness and observed set: `packages/connectors/src/run.ts`
- Postgres store and ports: `packages/db/src/missed-polls-store.ts`
- Migration: `packages/db/src/migrations/0009_source_record_missed_polls.sql`
