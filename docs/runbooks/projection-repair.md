# Search projection reconciliation and repair

This runbook compares the Postgres source of truth with the physical
Manticore active/archive tables. It is the required evidence step after a
full replay and the safe repair path for search-index drift.

Normal repairs use durable Postgres outbox events. The one exception is
physical corruption that a document-id-derived projector delete cannot reach:
`--apply` compare-and-deletes the exact inspected Manticore row (numeric id,
`document_id`, and `projection_hash`) while holding the shared search-index
generation fence, then enqueues the normal durable repair for the canonical
document. If another writer replaced that row after observation, the delete
matches nothing and the replacement survives.

## Usage

The real Manticore HTTP endpoint is mandatory. A DB-only result is not an
engine-convergence verdict.

```bash
MANTICORE_URL=http://manticore-<service-uuid>:9308 \
  bun run search:reconcile-projection

MANTICORE_URL=http://manticore-<service-uuid>:9308 \
  bun run search:reconcile-projection --apply --projector-quiesced
```

The default is report-only. Run it after the normal projector has drained the
outbox. Before any `--apply`, stop the projector and wait for every in-flight
drain to finish; keep it stopped until the command exits. The mandatory
`--projector-quiesced` flag is the operator's explicit acknowledgement of that
condition. The command rejects `--apply` without it. For a definitive dry-run
snapshot, quiesce ingestion as well.

## What is compared

The command uses bounded pages in two directions.

1. **Postgres-led:** every current `curated.aanvraag` is loaded through the
   projector's loader, compared with current-generation projection state, and
   looked up in both Manticore partitions. Its stored `projection_hash` is
   compared with the canonical hash calculated from the source document using
   one captured clock value for the entire run. The lookup is bounded by the
   requested numeric `hashDocumentId(document_id)` values, so a corrupt row
   occupying a canonical numeric id is returned and classified even when its
   stored `document_id` is wrong. Duplicate requested hashes across the entire
   Postgres-led scan (including collisions on different pages), duplicate
   returned numeric ids, and rows outside the requested hash set fail closed.

2. **Manticore-led:** numeric Manticore `id` keyset pages are scanned in both
   partitions. A canonical UUID that has no current aanvraag is an orphan;
   malformed `document_id`, duplicate, and non-canonical numeric-id rows are
   classified by their exact physical ids.

The numeric-id scan proves completeness by requiring the initial count, exact
number of scanned rows, and final count to agree. Apply mode first completes a
full report-only preflight; no durable repair is queued from an incomplete or
count-changing inventory.

For a current aanvraag, the report can identify:

- no Manticore document;
- a document in the wrong partition;
- a duplicate in active and archive;
- no projection-state row for the current generation; or
- a projection hash that no longer matches the source row.
- a physical Manticore `projection_hash` that no longer matches that same
  canonical source projection; or
- a physical numeric id that is not `hashDocumentId(document_id)`.

It prints exact totals and only capped samples, so a large index does not turn
operator output into an unbounded data dump.

### Closed drift class: seen-only and status-only curated writes (CTP-498)

Until CTP-498, an observation whose `content_hash` equalled the stored one
wrote `laatst_gezien_op`, `status`, and the RJC-394 derived columns on
`curated.aanvraag` with no outbox event. All of those fields are in the search
document and therefore in the projection hash, and the projector skips a later
same-content event, so the index kept a closed aanvraag active and a stale
last-seen date until the content changed; one measured run went from 0 to 46
source-hash mismatches in ten minutes against an empty outbox. That path now
enqueues its own event inside the same transaction as the row write:
`aanvraag.status_gewijzigd` when the status flips and `aanvraag.gewijzigd` when
only the last-seen date or a derived column moves. An observation that moves
nothing still writes nothing. To verify, let the poller run two full cycles with
the projector draining normally, then run the report-only reconciliation twice:
a source-hash-mismatch count that stays at 0 across both cycles is the evidence.
A non-zero count here is a new producer that writes a projected field without an
event, not a repair-tool problem; find the writer before applying repairs.

## Applying repairs

`--apply` handles each class as follows:

| Finding | Durable action |
| --- | --- |
| Current aanvraag has missing/wrong/duplicate engine rows | Transactionally invalidates its current-generation state and enqueues `aanvraag.projection_repair`. State invalidation forces the next projector drain to write even if the source hash itself is unchanged. |
| Missing state or source-hash mismatch | Enqueues `aanvraag.projection_repair`; a pending normal outbox event already covering that aanvraag is respected. |
| Valid UUID orphan in Manticore | Enqueues `aanvraag.verwijderd` and removes its current-generation state, so the projector clears both partitions. |
| Malformed, duplicate, or non-canonical physical row | Compare-and-deletes only when numeric id, `document_id`, and `projection_hash` still equal the fenced observation. A concurrently replaced canonical row is preserved. Canonical current documents are then covered by the normal repair event. |

After applying, drain the outbox with one projector and rerun the dry run.
Only a report with zero current divergences, zero valid UUID orphans, zero
physical corruption, and matching initial/scanned/final partition counts is
convergence evidence. A second `--apply` before the repair events drain is
idempotent: the pending events cover the same aggregates and already-deleted
physical ids no longer appear.

## What it refuses

The command exits without scanning when the checkpoint schema hash differs
from the deployed `SEARCH_SCHEMA_HASH`. That includes a
`search-reindex-pending:v1:...` marker. Do not queue repair events behind a
halted projector; follow [search-schema-migration.md](search-schema-migration.md)
to finish or resume the full replay first.

It also rejects malformed inventory pages (non-numeric, non-advancing, or
over-sized numeric-id pages), bounded lookups that omit a scanned row, and
partition counts that change during the scan rather than silently skipping
Manticore rows.

## Operational sequence after a replay

1. Finish `search:new-generation --apply` so the checkpoint has its final
   schema hash.
2. Start one projector and let the replay and normal outbox events drain.
3. Stop the projector and wait for any in-flight drain to finish.
4. Run this command without `--apply` against the actual Manticore URL.
5. If it reports repairable drift, keep the projector stopped and run with
   `--apply --projector-quiesced`.
6. Start one projector, drain the new events, stop it cleanly again, and return
   to step 4. Resume normal projector operation only after the final clean
   report.
7. Verify `/readyz`, outbox/dead-letter health, and the real search API
   separately from container health.

## Limitations and interpretation

- Direct physical cleanup is limited to ids discovered by the same bounded,
  fully counted inventory pass. Never substitute an ad-hoc broad Manticore
  `DELETE` for this path.
- `MANTICORE_URL` must point at the same active/archive tables the projector
  uses. A throwaway or local engine is useful for rehearsals, not a production
  convergence claim.
- Reindex, repair events, and physical cleanup use the same advisory-lock
  namespace and lock the named checkpoint row. That Postgres fence cannot
  serialize a Manticore write already in flight, so projector quiescence is
  mandatory for apply and producer quiescence remains required for an
  authoritative convergence snapshot.
