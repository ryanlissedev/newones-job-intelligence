/**
 * Operator entry point for a complete, restart-safe search replay.
 *
 *   bun run search:new-generation [--apply] [--force]
 *
 * Dry run is the default. `--apply` puts the checkpoint behind a pending
 * marker, writes one deterministic replay event per current aanvraag, then
 * releases the expected schema hash. `--force` only matters with a matching
 * hash: it deliberately starts another full generation.
 */
import {
  closeDb,
  db,
  runSearchReindex,
  SearchReindexPendingGenerationError,
} from "@ji/db";

const apply = process.argv.includes("--apply");
const force = process.argv.includes("--force");

try {
  const result = await runSearchReindex({ apply, database: db, force });
  console.log(
    `${result.dryRun ? "dry run" : "reindex"} ${result.action}: generation ${result.generation}, ` +
      `${result.scanned} current aanvraag rows, ${result.planned} replay events planned, ` +
      `${result.enqueued} inserted, ${result.existing} already durable.`
  );
  if (result.action === "already-current") {
    console.log(
      "Checkpoint already carries the running schema hash; pass --force to deliberately rebuild it."
    );
  } else if (result.dryRun) {
    console.log(
      "No checkpoint or outbox rows were changed. Stop the singleton projector, then re-run with --apply."
    );
  } else if (result.finalized) {
    console.log(
      `Generation ${result.generation} is now available to the projector. Restart it, drain the durable replay, ` +
        "then run the Manticore reconciliation dry run before declaring convergence."
    );
  } else {
    console.error(
      `Generation remains pending: ${result.blockedDeadLetter} replay event(s) are dead-lettered. ` +
        "Resolve/requeue them and re-run --apply; do not restart the projector yet."
    );
    process.exitCode = 1;
  }
} catch (error) {
  if (error instanceof SearchReindexPendingGenerationError) {
    console.error(error.message);
    process.exitCode = 1;
  } else {
    throw error;
  }
} finally {
  await closeDb();
}
