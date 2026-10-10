# Search schema migration and durable full replay

Use this runbook whenever `SEARCH_SCHEMA_HASH` changes, when a full search
replay is deliberately requested, or after a Manticore incident. Postgres is
the system of record; Manticore is a rebuildable derived index.

The CTP-534 skills mapping is activated only through the pending-generation
replay protocol: after deployment, operators run search:new-generation, drain
the new generation, and then run search:reconcile-projection. Do not mutate a
live Manticore table ad hoc.

This applies to the existing attributes and to the active/archive partition
layout (`aanvragen_active`, `aanvragen_archive`). It does not drop the legacy
`aanvragen` table or clear a Manticore volume automatically. The production
target remains `manticoresearch/manticore:6.3.8`; the Manticore 29 shadow and
any production upgrade decision are outside this runbook.

## Why the order matters

`drainPostgresOutbox` refuses a checkpoint whose `schema_hash` differs from
the code's `SEARCH_SCHEMA_HASH`. That normally makes `/readyz` report the
search projection as unavailable instead of silently indexing with a wrong
mapping.

`bun run search:new-generation --apply` deliberately puts the checkpoint into
the same mismatch state while it creates a complete replay. Its temporary
schema hash looks like:

```text
search-reindex-pending:v1:<encoded-schema-hash>:<high-water-uuid-or-empty>
```

The projector must remain stopped while that marker exists. A running or
in-flight projector can write an old batch after the new generation has
started; Manticore cannot fence that late engine write.

## Mapping-only refresh: `contracttype` / `contract_type` (RJC-442)

RJC-442 changes how the existing `contracttype` search attribute is populated;
it does not change `SEARCH_SCHEMA_HASH` or the Manticore table layout. The
projector loader reads `bronSpecifiek.contracttype` first and falls back to
`bronSpecifiek.contract_type`. Missing, `null`, non-string, and blank values
remain `null`. Leave the schema hash and table definitions unchanged for this
refresh.

Deploying that loader does not rewrite documents whose outbox events were
already processed. A caught-up outbox and version cursor only prove that the
projector handled the events it saw; they do not cause an unchanged curated row
to be loaded again. Existing indexed documents therefore need this explicit
same-schema replay:

1. Follow the environment, singleton ownership, and clean-stop requirements in
   [search-projector.md](search-projector.md). Stop the projector and wait for
   any in-flight drain to finish.
2. Inspect the new generation without writing:

   ```bash
   bun run search:new-generation --force
   ```

   The command without `--force` reports `already-current` because the schema
   hash is unchanged. Record the target, proposed generation, and planned row
   count, then obtain the normal operator approval for that environment.
3. For the first approved apply only, create the generation and enqueue the
   full current corpus:

   ```bash
   bun run search:new-generation --apply --force
   ```

4. If the command is interrupted while the generation is pending, keep the
   projector stopped and resume with `bun run search:new-generation --apply`
   **without** `--force`. Replay event IDs are deterministic for the index,
   generation, and aggregate; conflict-ignore inserts make committed pages
   safe to revisit.
5. After finalization, rerunning `bun run search:new-generation --apply`
   without `--force` must report `already-current` with zero events enqueued.
   Do not repeat `--apply --force`: after completion it deliberately starts a
   different generation and is not an idempotent verification command.
6. Start exactly one projector and drain the replay. Then quiesce it again and
   follow [projection-repair.md](projection-repair.md) for report-only physical
   Manticore reconciliation and any required repair cycle.

Keep evidence for each boundary: the generation record and finalized (not
pending) checkpoint; replay counts for scanned, planned, inserted, and existing
events; projector drain, cursor, lag, and dead-letter state; a clean physical
reconciliation against the configured Manticore engine; and search-path
readback showing the expected `contracttype` filter hit and facet bucket. Use a
preselected non-sensitive record for readback and record no payload, token, or
real identifier in this runbook. Fixture coverage that uses real Postgres with
the production in-memory search engine proves mapping/projector behaviour, but
it is not physical Manticore evidence. This procedure alone is not evidence
that a production refresh was run.

## Preconditions

1. Deploy the code and ensure the target Manticore schema/tables exist first.
   For a live RT table, `rt_attr_*` changes require an explicit SQL `ALTER
   TABLE`; editing `manticore.conf` alone does not change an existing table
   path. New active/archive tables are picked up from the config after a
   `searchd` restart.

2. Check the Manticore tables before touching the checkpoint:

   ```sql
   SHOW TABLES;
   DESCRIBE aanvragen_active;
   DESCRIBE aanvragen_archive;
   ```

   For the v4 projection fingerprint migration, add the attribute to each
   existing RT table before starting a new generation (new installations get
   it from `tools/manticore/manticore.conf`):

   ```sql
   ALTER TABLE aanvragen_active ADD COLUMN projection_hash string;
   ALTER TABLE aanvragen_archive ADD COLUMN projection_hash string;
   ```

   Run `DESCRIBE` again and prove `projection_hash` exists in both tables.
   Do not stamp the v4 checkpoint while either table still has the v3 shape.

3. Quiesce the singleton on-box projector through its supervisor and wait for
   any current drain request to finish. Confirm Trigger.dev is already in
   `SEARCH_PROJECTOR=onbox` mode, where its drain task defers, and prove no
   operator-started drain is running. Keep the projector stopped until the
   CLI exits 0 with `Generation <n> is now available to the projector`; that
   is its success output after finalization. Do not merely rely on a lease
   expiring. A database coordination lock cannot fence a Manticore write that
   was already in flight.

4. Keep `DATABASE_URL` scoped to the intended Postgres environment. Do not
   place it in shell history or this repository.

## Replay protocol

The required order is: **add the RT attribute -> start a new generation ->
replay every current aanvraag -> drain -> reconcile physical contents**. A
configuration-file edit or a checkpoint update alone skips required state.

First inspect the plan. This is read-only and does not create a checkpoint or
outbox events:

```bash
bun run search:new-generation
```

Record the plan and obtain operator approval for its target environment,
schema hash, generation, and planned current-aanvraag count. With the
projector still stopped, create or resume the durable replay:

```bash
bun run search:new-generation --apply
```

The command captures a high-water UUID, creates the pending marker, and pages
through every current `curated.aanvraag`. Each row receives a deterministic,
idempotent `aanvraag.search_reindex` outbox event. Existing projection state
and processed historical events do not suppress this replay.

When every page has committed, the command checks for dead-lettered replay
events belonging to that exact index/generation, then atomically replaces the
pending marker with `SEARCH_SCHEMA_HASH`. Only then may the projector start.

`--force` is only for deliberately creating another generation when the
checkpoint already has the current schema hash, such as rebuilding empty
Manticore tables after host loss. Inspect that path first with the read-only
`bun run search:new-generation --force`; only the deliberate, approved apply
phase uses:

```bash
bun run search:new-generation --apply --force
```

It never replaces a pending generation. A matching pending marker is always
resumed; a pending marker for a different schema hash is an operator stop.
The replay enumerates every current `curated.aanvraag` behind its captured
high-water boundary and does not depend on retained historical outbox rows.
The durable current-corpus replay is self-contained; no historical-outbox
recovery procedure participates in this bootstrap.

### Recovery and resume

| Observation | Action |
| --- | --- |
| Process stopped after the marker or after a page | Keep the projector stopped and rerun the same `--apply`. Deterministic event IDs make committed pages conflict-safe. |
| Command says replay events are dead-lettered | Resolve or requeue those replay events, then rerun `--apply`. The marker stays pending on purpose. |
| Marker names a different schema hash | Do not force over it. Determine which deployment owns the marker and finish or recover that migration first. |
| Command exits 0 and reports that the generation is available | Start one projector, drain the durable replay, then reconcile the physical Manticore contents. |

Do not hand-edit `search_projection_checkpoint.schema_hash` to bypass any of
these cases. That would allow a partial generation to drain.

## Drain and reconcile

After a successful finalize, restart exactly one projector and wait for its
outbox lag and dead-letter queue to settle. Then stop it again and wait for any
in-flight drain to finish before reconciliation. A replay replaces every
current document, but it cannot remove an old Manticore row that no longer has
a curated aanvraag. Reconciliation is therefore a required post-drain step:

```bash
MANTICORE_URL=http://manticore-<service-uuid>:9308 \
  bun run search:reconcile-projection
```

The default is the mandatory report-only preflight. If it reports
current-document drift, valid UUID orphans, or malformed/non-canonical physical
rows, keep the projector stopped and apply the exact observed-row cleanup plus
durable repair/delete events. The acknowledgement flag is required:

```bash
MANTICORE_URL=http://manticore-<service-uuid>:9308 \
  bun run search:reconcile-projection --apply --projector-quiesced
```

Apply internally repeats the complete counted preflight before mutating. Its
physical delete matches the full observed fingerprint: numeric id,
`document_id`, and `projection_hash`. It therefore cannot delete a canonical
row that replaced a corrupt row between listing and cleanup. Start one
projector to drain the emitted events, stop it cleanly again, and run the
report-only command once more. A convergence claim needs zero current
divergences, zero valid UUID orphans, zero physical corruption, and exact
initial/scanned/final counts.

## Verification

1. Check the target checkpoint:

   ```sql
   SELECT index_name, generation, schema_hash, applied_sequence
   FROM curated.search_projection_checkpoint;
   ```

   `schema_hash` must equal the deployed `SEARCH_SCHEMA_HASH`, not the
   pending marker.

2. Confirm the projector drained successfully, its outbox lag is zero (or has
   a known active producer), no replay event is dead-lettered, and the
   projector is stopped with no drain in flight during reconciliation apply.

3. Use the reconciliation dry run above with the real `MANTICORE_URL`.
   Postgres-only state agreement is not a Manticore convergence verdict. The
   report must also show zero physical corruption, zero stored
   `projection_hash` drift, and exact initial/scanned/final counts per
   partition.

4. Exercise the production search path, including `scope: "active"` and
   `scope: "all"` for the partitioned layout. Verify `/readyz` separately
   from container health.

## Partition layout notes

The projector writes open records to `aanvragen_active`; `closed`, `stale`,
or passed-deadline records go to `aanvragen_archive`. Moves are replace-first
in the target partition followed by deletion from the other partition. The
projection hash records the partition prefix (`active:` / `archive:`).

For a new installation, define both tables in `tools/manticore/manticore.conf`
and restart `searchd`. On an existing volume, adding those *new* tables is
safe; altering attributes of an existing path still needs explicit SQL. Keep
the legacy `aanvragen` table until the reconciliation and live search evidence
show no consumers. Its eventual removal is a separate operator decision.

`ACTIVE_RECENT_DAYS` is currently `null`: an open record stays active until
its lifecycle changes. Enabling a time window needs a periodic outbox sweep
so records crossing the boundary are re-projected.
