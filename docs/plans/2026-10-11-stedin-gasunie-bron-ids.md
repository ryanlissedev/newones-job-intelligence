# Stedin and Gasunie get their own bron ids; the seed fails loudly on an id collision

Status: draft PR (2026-10-11). Nothing in production has changed. The prod step below needs Ryan's GO.

## Problem
- The registry gave Stedin `…035` and Gasunie `…036` (`packages/application/src/sources/{stedin,gasunie}.ts`).
- The v1 backfill bindings already used the same ids for Werkzoeken and Starapple (`packages/application/src/backfill/motian-v1-bindings.ts`), and prod holds those v1 rows.
- Both seed writers are insert-only, `ON CONFLICT (id) DO NOTHING`:
  - `ensureMissingSliceABronnen` in `apps/worker/src/smoke-seed.ts`;
  - `seedMotianV1Bronnen` in `packages/db/src/backfill-stores.ts`.
- So seeding Stedin/Gasunie was silently skipped. The only trace was `naamConflicts` in the reconcile report (`docs/evidence/bron-seed-reconcile`).

## Change (this PR)
- **New ids:** Stedin `00000000-0000-4000-8000-000000000046`, Gasunie `…047`. Both are above the highest registry id (`…045`) and unused by any bron.
- **Unchanged:** `…035`/`…036` stay Werkzoeken/Starapple (v1 bindings untouched).
- **Fail loudly:** both seed writers now check the row that won `ON CONFLICT (id)`.
  - If its naam differs from the seed, ignoring case and outer whitespace like the `lower(naam)` unique index, they throw `BronSeedIdCollisionError`.
  - The error names the id, the db naam and the seed naam. Nothing is written for that bron.
  - An operator-reviewed row of the *same* bron is still left untouched.
- **Guard test:** a v1 binding may never sit on a registry id with a different naam. Striive and Opdrachtoverheid share ids on purpose and have the same naam.
- **No migration:** no data or binding needs to move. Bron rows are seed data, not schema. See "Data impact".

## Data impact in prod (expected)
- **Rows that move: 0.**
  - The poller maps a bron row to a connector **by naam** (`resolveSourceByNaam` in `listPollableSliceABronnen`), not by id.
  - The `…035`/`…036` rows are named Werkzoeken/Starapple, which have no registry source, so the Stedin/Gasunie json-ld connectors never ran under those ids.
  - All aanvragen there should be v1 backfill rows (`v1_id` set, `run_kind = backfill`).
- **Rows added: 2** `curated.bron` rows, Stedin `…046` and Gasunie `…047`.
  - Both are inactive (`actief = false`), with `status = deferred` and `voorwaarden_status = te_toetsen`.
  - Nothing polls them until their terms are reviewed and they are activated, which is a separate decision.
- **Rows changed: 0.**

## Prod operator plan (do not run without GO)

| # | Step | Who / role | Impact | Rollback |
|---|---|---|---|---|
| 1 | `tools/postgres/bron-ids/01-precheck.sql` | Grok Bot, ji_readonly | read-only (`BEGIN READ ONLY … ROLLBACK`) | none |
| 2 | Check the output. Section 1: …035 = Werkzoeken, …036 = Starapple, nothing on …046/…047, no Stedin/Gasunie naam. Sections 2–4: only v1/backfill data under …035/…036 (`from_v1 = t`, no `poll` runs, no json-ld fetch history). **If any live/poll data appears, stop:** that data would have to move, which needs a separate additive plan. | operator | none | none |
| 3 | Merge + deploy this PR (code only; no migration). The poller boot reconcile then reports Stedin/Gasunie as `missingRows` instead of `naamConflicts`. | deploy | no DB change | redeploy previous release |
| 4 | `tools/postgres/bron-ids/02-apply-seed-rows.sql`: one transaction that fails closed on any id/naam collision and is idempotent | ji_migrator | +2 inactive bron rows; locks: row-level only | leave the rows (inactive, no data), or `UPDATE … SET actief = false` if activated by mistake; deleting needs a GO (`90-rollback.sql`) |
| 5 | Re-run 01 (rows present) and check the poller boot line: `bron_seed_drift` no longer lists `naamConflicts` for gasunie/stedin | Grok Bot | read-only | — |

Activating Stedin/Gasunie (terms review, `actief = true`) is out of scope.

## Tests
- `bron-seed-identity.spec.ts` (unit).
- `smoke-seed.spec.ts` (DB):
  - a row of another bron on the id → `BronSeedIdCollisionError`, row untouched;
  - a case-only naam difference → same bron, no error.
- `motian-v1-bindings.spec.ts`: the registry vs v1 binding collision guard, and the new ids pinned.
- `seed-reconcile.spec.ts`: v1 rows no longer conflict with Stedin/Gasunie, and a collision is still flagged.
- `bron-ids-operator.spec.ts` (DB):
  - the apply script writes exactly the registry seed values, and is idempotent;
  - it aborts on a collision.
