/**
 * Read-only report: code registry (`SOURCES`) vs `curated.bron` rows.
 *
 *   bun apps/worker/scripts/bron-seed-reconcile.ts [--strict]
 *
 * It prints the report as JSON. With --strict, it exits 1 when there is drift
 * (for CI or release checks). It never writes: the rows are read in a READ ONLY
 * transaction, and every difference is for an operator to resolve.
 */
import path from "node:path";

import { config as loadEnv } from "dotenv";

import {
  createPollBronRuntime,
  requireDatabaseUrl,
} from "../src/poll-bron-run";
import { reportSeedDrift } from "../src/seed-reconcile";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
loadEnv({ path: path.join(repoRoot, "apps/server/.env") });
loadEnv({ override: true, path: path.join(repoRoot, "apps/worker/.env") });

const main = async (): Promise<void> => {
  const strict = process.argv.slice(2).includes("--strict");
  const runtime = createPollBronRuntime(requireDatabaseUrl());
  try {
    const report = await reportSeedDrift(runtime.database);
    console.log(JSON.stringify(report, null, 2));
    if (strict && !report.inSync) {
      process.exitCode = 1;
    }
  } finally {
    await runtime.close();
  }
};

await main();
