# Read paths skip superseded aanvragen

Status: draft PR, follow-up to #483 (d335981). It must be deployed **before** any mark step that actually supersedes rows: #486 URL dedup, or a non-empty re-run of `tools/postgres/unique-key/03-mark-superseded.sql`. Prod today has 0 superseded rows and 0 archive rows, so this change is a no-op there until something is marked.

## Rule
A row with `curated.aanvraag.superseded_by IS NOT NULL` is a merged duplicate. It is never listed, searched, counted, enriched or exported on its own. A detail read by its id resolves to the live row it was merged into, the same way `findAanvraagByIdentity` does.

## Read paths changed

| Path | Where | Behaviour |
|---|---|---|
| Detail (tRPC/REST `getAanvraag`, versies existence check, markering, export `commitExport` by `canonicalVacancyId`) | `PostgresAanvraagStore.getById` | Follows `superseded_by` (max 5 hops) and returns the **kept** row, including its id; unknown or broken chain → null. |
| Batch hydration (search result list, compare, export selections, assistant/MCP tools via the same handlers) | `PostgresAanvraagStore.getByIds` | Superseded ids resolve to the kept row; input order is kept and each live row appears once. |
| Markering on a superseded id | `createMarkeerAanvraagHandler` | Stored on the kept row (`exists.id`). |
| Search projection (projector, single + bulk drain) | `PostgresSearchDocumentLoader.loadByAggregateId` / `loadManyByAggregateIds` | Superseded rows never load, so any upsert event for them is a no-op and they are never (re)added. |
| Row becomes superseded → index delete | `tools/postgres/unique-key/03-mark-superseded.sql` | Inserts one `aanvraag.verwijderd` outbox event per marked row in the same statement. Rollback section B enqueues `aanvraag.gewijzigd` to re-project unmarked rows. |
| Safety net | `projection-repair.ts` (`reconcileProjection`) | A superseded row still in Manticore counts as an orphan and gets a delete; superseded rows are not reported as missing from the index. |
| Full rebuild | `search-reindex.ts` page scan | Live rows only. |
| Enrichment candidates (Trigger task + on-box oneshot) | `enrichment-store.ts` `incompleteAanvraagSql` | `superseded_by IS NULL` (affects listIncomplete, listIncompleteById and listPendingCuratedApply). |
| Bron overlap stats (dashboard "marts") | `bron-overlap.ts` | Every scan counts live rows only. |

**List, search and counts** all come from the Manticore projection, hydrated via `getByIds`, so they follow from the projection change. Between a mark and the projector draining its delete event, a stale hit hydrates to the kept row and is de-duplicated.

**Not changed (write/identity paths, intentionally):**
- `curate-scrape-run.ts` observation classification lookups;
- `backfill-stores.ts`;
- `postgres-curate-store.ts`, which already resolves superseded rows since #483.

**Marts / views:** the `marts` schema has no views or tables reading `curated.aanvraag`, so **no migration is needed**.

## Before #486 is applied
#486's `url-dedup.sql` must enqueue the same `aanvraag.verwijderd` outbox event per marked row as 03 now does (follow-up commit on #486). Until then, `reconcileProjection --apply` after the mark removes the documents as orphans.

## Prod operator steps
None for this PR: code only, no migration, no data change. Deploy the server, projector and worker as usual.

## Rollback
Revert the PR. No schema or data depends on it.
