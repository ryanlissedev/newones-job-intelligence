# Motian v1 derived-field repair

This is a bounded diagnostic and repair tool for a small, explicitly approved
set of historical Motian rows. The default mode reads the current curated row
and its current immutable S3 raw object, then reports which null derived fields
could be recovered. It never connects to Motian. `--apply` is a separate,
quiescence-gated mode that writes only the five derived fields, one audit event,
and one `aanvraag.gewijzigd` outbox event per changed row.

Use it when a current `curated.aanvraag` row has a Motian `v1_id`, a
content-addressed JSON raw pointer, and a missing one of:

- `opdrachtgever_naam`
- `contracttype`
- `publicatiedatum`
- `start_datum`
- `sluitingsdatum`

## Preconditions

Use a destination `DATABASE_URL` with read access and the normal durable raw
store variables: `RAW_S3_BUCKET`, `RAW_S3_ACCESS_KEY_ID`,
`RAW_S3_SECRET_ACCESS_KEY`, and, where applicable, `RAW_S3_ENDPOINT` and
`RAW_S3_REGION`. The tool refuses the worker-local filesystem store.

Prepare a reviewed JSON manifest with at most 100 candidates. Each candidate
binds the exact current row and raw pointer; do not construct it from `v1_id`
alone.

```json
{
  "version": "motian-v1-derived-field-repair/v1",
  "candidates": [
    {
      "aanvraagId": "curated-aanvraag-uuid",
      "bronId": "source-uuid",
      "bronReferentie": "source-reference",
      "contentHash": "64-character-lowercase-sha256",
      "rawPayloadRef": "raw/source/2026/09/64-character-lowercase-sha256.json",
      "v1Id": "motian-job-id"
    }
  ]
}
```

The manifest is an approval artifact. Store it outside Git when its source
references are sensitive. Its SHA-256 is included in the report, so the exact
bytes used for a review can be recorded without printing any raw values.

## Run a bounded dry run

The explicit limit is required and must be at least the manifest size. This
prevents an accidental corpus scan.

Typecheck the standalone tools explicitly; the workspace-wide `check-types`
command does not include files under `tools/backfill`.

```bash
bun run check-types:backfill
```

```bash
bun tools/backfill/repair-motian-v1-derived-fields.ts \
  --manifest /secure/path/motian-pilot.json \
  --limit 10
```

The output contains only candidate `v1Id`s, plan/result counts, field names,
reason codes, and the manifest digest. It does not print a raw payload,
company name, description, source reference, database URL, or credential.

## How a candidate is accepted

For every candidate, the diagnostic verifies all of these before proposing a
field:

1. The current row exactly matches all manifest identity, hash, and pointer
   values.
2. Its raw ref is a content-addressed JSON path, and the raw object's SHA-256
   matches both that path and the current row's `content_hash`.
3. The raw root decodes as the original `to_jsonb(jobs)` Motian shape. Native
   source payloads, including Striive `{ "job": ... }` records, are rejected.
4. Raw `id`, normalized platform/bron binding, and `external_id` match the
   current curated identity.
5. The source publishes a concrete field value and the curated target is
   currently `NULL`.

Timezone-less historical timestamps use the same explicit UTC conversion as
the original Motian backfill. Missing source data stays absent.

## Interpret and retain the report

`wouldPatch` is grouped by field. `projectionEventsRequired` is the count of
rows that would need a normal `aanvraag.gewijzigd` event during apply.
`raw_schema_not_motian` is expected for rows whose current raw pointer has
since been replaced by a live native-source payload; do not attempt to repair
those with this tool.

Attach the reviewed manifest digest and redacted report to CTP-492. An apply
must be preceded by a reviewed dry-run report and an ingest freeze. Stop
all writers that can change `curated.aanvraag` or its raw pointer, wait for
in-flight work to finish, and retain the exact manifest bytes and digest.

## Apply the reviewed manifest

`--apply` requires both the exact manifest and an explicit
`--ingest-quiesced` acknowledgement. The limit remains mandatory and is capped
at 100; the tool refuses a manifest larger than the limit.

```bash
bun tools/backfill/repair-motian-v1-derived-fields.ts \
  --apply --ingest-quiesced \
  --manifest /secure/path/motian-pilot.json \
  --limit 10
```

Each candidate is re-read, the row is locked and all six identity bindings are
checked again, and the raw object is validated before the transaction commits.
Only fields that are still `NULL` are set. The derived-field update, strict audit event containing the five-field before and after values, and one `aanvraag.gewijzigd` outbox event commit
atomically. Candidate failures are isolated and reported by reason code; raw
hash mismatches remain distinct from other raw read failures.

The apply mode never changes identity, raw pointers, content hashes, versions,
history, or raw storage. Keep the returned audit IDs, outbox IDs, field names,
reason codes, and manifest digest with the repair record.

## Bounded rollback

Rollback is also quiescence-gated and accepts only one repair audit ID. It
restores a field only while it still equals that repair's recorded after-image;
later edits are reported as skipped. A rollback audit and outbox event are
written atomically with any restored fields. If every changed field has a later
value, rollback is an unchanged no-op.

```bash
bun tools/backfill/repair-motian-v1-derived-fields.ts \
  --rollback --ingest-quiesced \
  --audit-id 00000000-0000-4000-8000-000000000000
```

## Full corpus run

The bounded tool above takes a hand written manifest of at most 100 candidates.
Production holds roughly 256,000 eligible rows across seven sources, so the
corpus is repaired with a resumable bulk runner that wraps the same bounded
core. `tools/backfill/repair-motian-v1-derived-fields-bulk.ts` selects
candidates from `curated.aanvraag` in cursor ordered batches, builds each
manifest in memory, and hands that manifest to the same plan and apply
functions the bounded CLI uses. It adds no new validation, no new binding, and
no new write path. Every candidate is still re-read, locked, and checked
against all six identity bindings inside its own transaction.

Selection takes rows that have a Motian `v1_id`, a content addressed raw
pointer that matches the current `content_hash`, and at least one of the five
derived fields this tool repairs still null: `contracttype`,
`opdrachtgever_naam`, `publicatiedatum`, `sluitingsdatum`, or `start_datum`.
The null predicate covers exactly those five columns and nothing else, because
a row whose only null is a column the repair never writes has nothing to
recover and would only waste a manifest slot. Rows are ordered by `id` and the
last `id` of each committed batch becomes the resume cursor.

```bash
bun tools/backfill/repair-motian-v1-derived-fields-bulk.ts \
  --apply --ingest-quiesced \
  --batch 100 \
  --max-batches 20 \
  --state /secure/path/motian-corpus-state.json
```

Drop `--apply` and `--ingest-quiesced` for a report only pass. Report mode is
the default and never calls the apply path. `--batch` accepts 1 through 100 and
defaults to 100. `--max-batches` is required; it bounds one run so that an
operator raises the number deliberately rather than starting an unbounded
corpus scan. `--cursor` accepts an explicit `curated.aanvraag` uuid and
overrides the resume point recorded in the state file.

### The state file is the approval and resume artifact

`--state` is required. The runner rewrites that file after every committed
batch, writing a temporary sibling first and renaming it over the target, so a
run that is killed at any moment leaves either the previous complete state or
the new complete state and never a half written one. The file records the
schema version, the resume cursor, one entry per batch with its index, manifest
SHA-256, selected count, patched or would patch count, rejection count and
reason codes, the audit ids the batch produced, its start and finish
timestamps, and the running totals.

Keep this file with the repair record the way the bounded run keeps its
reviewed manifest and digest. The per batch manifest digest is reproducible
from the same candidate rows, so a reviewer can confirm exactly which bytes a
batch bound without any source reference being printed or stored. The runner
prints counts, reason codes, digests, and audit ids only. It never prints a raw
payload, a company name, a source reference, a v1 id, or a database URL.

On start, if the state file exists the run appends to its batch list rather
than replacing it, so the audit ids of earlier batches are never dropped. The
resume point is the cursor in that file unless `--cursor` overrides it. Point a
new run at a fresh state path when starting a new campaign.

### Ingest stays frozen for the whole run

An apply run inherits the bounded tool's quiescence gate: `--apply` requires
`--ingest-quiesced` and is rejected without it, and passing
`--ingest-quiesced` without `--apply` is rejected as well. The freeze covers
the entire multi batch run, not one batch. Stop every writer that can change
`curated.aanvraag` or its raw pointer before the first batch and keep them
stopped until the last batch of the run has committed, because the cursor
assumes the selected set is stable while the run walks it.

### Stop on the first blocking rejection

An apply run stops as soon as a batch reports a rejection whose reason is not in
the benign set. It prints the blocking reason codes and exits non zero. The
failing batch is already written to the state file with its cursor, its audit
ids, and its full reason code counts, so a rerun resumes after it rather than
repeating it. Investigate before continuing.

The benign set is the exported constant `BENIGN_BULK_REJECTION_REASONS` in
`tools/backfill/repair-motian-v1-derived-fields-bulk.ts` and currently holds one
reason, `raw_schema_not_motian`. That reason means the row's raw pointer has
since been replaced by a live native source payload, so the row is unrepairable
by design rather than a sign that something went wrong, and halting the corpus
on it would stop every run on its first batch. Benign rejections are still
counted per batch in the state file, so the permanently skipped population stays
visible and auditable. Any other reason, including `transaction_failed` and
`current_row_mismatch`, stops the run, and a batch that mixes a benign reason
with a blocking one stops on the blocking one.

Report mode does not stop on rejections at all. A report pass is meant to survey
the whole corpus and count every reason code, so it records them and keeps going.

Run a report pass over the range first, read its totals and reason codes, and
only then plan the apply.

### Drain the projector backlog afterwards

Every applied row commits one `aanvraag.gewijzigd` outbox event alongside its
field update and audit event, exactly as the bounded tool does. At corpus scale
that is the difference: a bounded run adds at most 100 events, while a full
campaign adds up to one event per applied row across every batch, so the
projector backlog grows by up to the total applied count in the state file. The
projector may keep running during the campaign; it is a reader of the outbox and
is not part of the ingest freeze. Plan for the backlog either way. After the last
batch, watch the outbox drain to zero and reconcile the projections against
`curated.aanvraag` before calling the campaign done, because the repair is not
observable downstream until those events have been processed. The applied totals
in the state file are the expected event count to reconcile against.

### Rollback

Rollback is unchanged and stays bounded to one repair audit at a time. Each
batch entry in the state file lists the audit ids that batch committed, and each
of those ids feeds the existing bounded command:

```bash
bun tools/backfill/repair-motian-v1-derived-fields.ts \
  --rollback --ingest-quiesced \
  --audit-id 00000000-0000-4000-8000-000000000000
```

Roll back in reverse order, newest batch first, and remember that a field is
restored only while it still equals that repair's recorded after image. There is
no bulk rollback mode on purpose: undoing a corpus wide write is a decision per
audit event, not a single flag.
