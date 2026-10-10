# Unique live key for curated.aanvraag (bron_id, bron_referentie): mark, never delete

Status: draft (2026-10-10). Nothing in production has changed. Steps 3–5 each need an explicit GO.

## What exists today (main 27b7579)

There is no `extern_id` column. The external identity is `bron_referentie`, scoped by `bron_id`:

| Table | Key | How writes treat it |
|---|---|---|
| `staging.source_record` | `source_record_bron_referentie_uidx (bron_id, bron_referentie)` | `INSERT … ON CONFLICT (bron_id, bron_referentie) DO NOTHING` (`bron-runtime.ts`) |
| `staging.aanvraag_observation` | `aanvraag_observation_replay_uidx (scrape_run_id, source_record_id, content_hash)` | `ON CONFLICT` on the replay key |
| `staging.source_fetch_history` | PK `(bron_id, bron_referentie)` | upsert on the PK |
| `curated.aanvraag` | `aanvraag_bron_referentie_uidx (bron_id, bron_referentie)`, `aanvraag_v1_id_uidx (v1_id) WHERE v1_id IS NOT NULL` | select-then-insert via `findAanvraagByIdentity(bronId, bronReferentie)`; the unique index is the backstop |
| `curated.aanvraag_bron_link` | `(aanvraag_id, bron_id)` unique | — |
| `curated.dedup_groep` | `dedup_key` partial unique | `ON CONFLICT (dedup_key)` |

So an exact duplicate on `(bron_id, bron_referentie)` cannot exist. Duplicates arise in three other ways:

1. **Normalization-only variants under one bron.** The key is compared byte-for-byte, so `JOB-1`, `job-1` and ` job-1 ` are three identities. v1 backfill writes `bron_referentie = v1.external_id` verbatim; live json-ld sources write `urlSlugBronReferentie(url)` (decoded path, slashes trimmed). Casing and whitespace differences across those producers yield two rows for one posting.
2. **Bron-id collision 035/036.** The v1 bindings (`packages/application/src/backfill/motian-v1-bindings.ts`) use `00000000-0000-4000-8000-000000000035` for Werkzoeken and `…036` for Starapple. The bron registry uses the same ids for Stedin and Gasunie (`packages/connectors/src/json-ld/configs/stedin.ts`, `gasunie.ts`). In prod those ids hold Werkzoeken/Starapple, the seed reports `naamConflicts` and its `ON CONFLICT DO NOTHING` silently skips Stedin/Gasunie (`docs/evidence/bron-seed-reconcile/README.md`). If a Stedin/Gasunie config ever polls under those ids, its postings land under the Werkzoeken/Starapple bron. That is a bron-identity bug, not a key bug: the fix is new registry ids (decision below), not an index.
3. **Same posting, different referentie** (v1 numeric id vs live URL slug). Not a key collision; it is a dedup concern (`dedup_groep`). `dup-analysis.sql` section 10 sizes it.

## Step 0: measure (read-only)

`dup-analysis.sql` (handoff dir) runs as `ji_readonly` inside `BEGIN READ ONLY … ROLLBACK` with `statement_timeout 60s` and `lock_timeout 2s`. It reports index presence and validity, owners, row counts, v1 vs live per bron, exact duplicates (expect 0), null/empty/padded refs, collisions per normalization tier (T1 trim, T2 +lower, T3 +slash/underscore/dashes), examples (ids only), v1-vs-live same-URL groups, and the 035/036 rows and runs.

**Decision gate:** if T2 has 0 collisions and section 6 shows no padded or uppercase refs that matter, steps 1–5 are optional hardening and the urgent work is only the bron-id fix. If T3 has collisions that T2 does not, decide whether T3 is the key (open question 3).

## Design (this PR, draft)

* **0033 (additive):** `curated.aanvraag.superseded_by uuid`, `superseded_at timestamptz` and `superseded_reason text`, all nullable with no default (catalog-only ADD COLUMN). Plus `curated.aanvraag_dup_archive`: `aanvraag_id`, `kept_aanvraag_id`, `bron_id`, `bron_referentie`, `normalized_referentie`, `reason`, `row_snapshot jsonb` (full `to_jsonb(row)`), `archived_at`, `archived_by` and `restored_at`. A jsonb snapshot instead of a column copy so the archive never drifts from `aanvraag`.
* **0034:** `CREATE UNIQUE INDEX IF NOT EXISTS aanvraag_bron_referentie_live_uidx ON curated.aanvraag (bron_id, lower(btrim(bron_referentie))) WHERE superseded_by IS NULL`. The exact index stays.
* **No delete.** A duplicate is marked: `superseded_by` points at the kept row, and the full row is snapshotted in the archive. FKs (`aanvraag_versie`, `aanvraag_bron_link` with ON DELETE CASCADE, user tables) stay intact. A DELETE would cascade, which is the main reason it is not proposed.
* **Keep rule** (identical in 02 and 03), first wins within a `(bron_id, lower(btrim(ref)))` group of not-superseded rows:
  1. most recent `laatst_gezien_op`;
  2. live (`v1_id IS NULL`) before v1;
  3. highest `compleetheid_score`;
  4. oldest `eerste_gezien_op`;
  5. lowest `id`.
* **Code:**
  * `findAanvraagByIdentity` does an exact match first. On a miss it takes the live row with the same normalized referentie (uses the new index). A superseded hit resolves to `superseded_by`.
  * `updateAanvraag` keeps the stored referentie when the patch only differs in case or whitespace, so the exact unique index can never be hit by a variant still held by a superseded row.

### ON CONFLICT / upsert fit

* `staging.source_record`: unchanged (exact key, `ON CONFLICT DO NOTHING`). A case variant is still a second staging record; curation then maps it onto the one live aanvraag through the normalized lookup. No conflict-target change is needed.
* `curated.aanvraag` has no `ON CONFLICT` upsert; it is select-then-insert. With 0034, an insert of a normalized variant while a live row exists would raise a unique violation. The lookup change prevents that, and the index remains the race backstop (a concurrent second insert fails and retries as an update, same as today with the exact index).
* v1 backfill (`neon-v1.ts`) uses the same lookup. A v1 ref that only differs in case from a live row now resolves to it, and the existing `PROVENANCE_MISMATCH` check fails closed instead of inserting a second row.
* Ownership: all DDL runs as `ji_migrator` (migrations, and the operator scripts via `MIGRATION_DATABASE_URL`), so the archive table and index are owned by the migration role. The migrator preflight (PR #482) fails fast otherwise.

## Production plan (each step needs a GO; writers = poller + projector, option B)

| # | Step | Runs as | Locks / impact | Rollback |
|---|---|---|---|---|
| 0 | `dup-analysis.sql` | ji_readonly | ACCESS SHARE only; ≤60 s per query | none needed |
| 1 | `tools/postgres/unique-key/01-prepare.sql` | ji_migrator | 3× brief ACCESS EXCLUSIVE (catalog-only ADD COLUMN, `lock_timeout 5s`); new empty table | leave in place (unused); dropping is destructive and needs a GO |
| 2 | `02-plan-dry-run.sql` | ji_readonly / ji_migrator | read-only | none |
| 3 | `03-mark-superseded.sql` (writers stopped) | ji_migrator | ROW EXCLUSIVE + row locks on marked rows only; one transaction; fails closed if any group remains | `90-rollback.sql` B (unmark from the archive tag; sets `restored_at`) |
| 4 | `04-unique-index-concurrently.sql` (writers may run) | ji_migrator | SHARE UPDATE EXCLUSIVE for the build; reads and writes continue; 2 scans of aanvraag | `90-rollback.sql` A (`DROP INDEX CONCURRENTLY`) |
| 5 | Deploy release with 0033+0034+code: migrator (option B), then server, poller, web, projector | — | 0033/0034 are no-ops (IF NOT EXISTS); readiness expects 0034 | redeploy previous release; the columns and index are harmless to old code |
| 6 | Follow-ups (separate PR) | — | — | — |

Step 6 follow-ups (not in this PR):
* Read paths exclude superseded rows: search projection, list/detail API and marts counts. Until then, marked rows still show. Marking does not emit outbox events, so a reindex of the affected ids is needed after step 3.
* Emit one outbox event per marked row (or run the projection repair for the archived ids).
* Bron-id fix for Stedin/Gasunie (open question 1).

If step 5 is deployed without steps 3–4 on a database that still has normalized duplicates, 0034 fails, drizzle rolls the batch back and the migrator restart-loops. The option B 2-minute rule catches that: stop, restart the writers, run steps 3–4, redeploy.

## Open questions for Ryan

1. **Stedin/Gasunie bron ids.** Assign new registry ids (e.g. the next free `…0xx`) and keep `…035/036` for Werkzoeken/Starapple? Recommended: yes, since the v1 ids are already in prod rows. The registry change plus a seed run is a separate PR.
2. **DELETE vs mark.** This plan never deletes. If you ever want rows physically removed, that is a separate decision (cascades to `aanvraag_versie` and `aanvraag_bron_link`). Not proposed.
3. **Normalization tier for the key.** T2 (`lower(btrim())`) is implemented. T3 (also trailing slash, `_`→`-`, collapsed dashes) merges more but can join ids a source considers distinct. Decide after `dup-analysis` section 7.
4. **Keep rule.** Is "most recently seen, then live over v1" right, or should v1 rows win (older history and the `v1_id` link)?
5. **Cross-bron duplicates** (same posting at two bronnen) stay a `dedup_groep` concern and are out of scope here.
