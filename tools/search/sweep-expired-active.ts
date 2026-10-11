import {
  closeDb,
  db,
  runSearchExpirySweep,
  SEARCH_EXPIRY_SWEEP_DEFAULT_BATCH_SIZE,
  SEARCH_EXPIRY_SWEEP_DEFAULT_MAX_PER_RUN,
} from "@ji/db";

const apply = process.argv.includes("--apply");

try {
  const result = await runSearchExpirySweep({
    batchSize: SEARCH_EXPIRY_SWEEP_DEFAULT_BATCH_SIZE,
    database: db,
    maxPerRun: SEARCH_EXPIRY_SWEEP_DEFAULT_MAX_PER_RUN,
    mode: apply ? "apply" : "dry-run",
  });
  console.log(
    `${result.mode}: ${result.candidates} expired active candidate(s), ` +
      `${result.enqueued} event(s) enqueued, ${result.skippedPending} skipped ` +
      `because pending, capped=${result.capped}`
  );
  if (result.sampleIds.length > 0) {
    console.log(`  sample ids: ${result.sampleIds.join(", ")}`);
  }
  if (result.skipped) {
    console.log(`  skipped: ${result.skipped}`);
  }
} finally {
  await closeDb();
}
