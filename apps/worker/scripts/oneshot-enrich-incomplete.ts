import path from "node:path";

import { config as loadEnv } from "dotenv";

import { runEnrichIncomplete } from "../src/enrich-incomplete-run";
import type { EnrichIncompleteResult } from "../src/enrich-incomplete-run";
import { enrichOneshotPayloadFromEnv } from "../src/oneshot-enrich-incomplete";
import type { EnrichOneshotPayload } from "../src/oneshot-enrich-incomplete";

// Same env loading as oneshot-slice-a-polls.ts: a host checkout reads the
// local .env files; inside the poller container they are absent and the
// Coolify application env (internal DATABASE_URL) applies.
const repoRoot = path.resolve(import.meta.dirname, "../../..");
loadEnv({ path: path.join(repoRoot, "apps/server/.env"), quiet: true });
loadEnv({
  override: true,
  path: path.join(repoRoot, "apps/worker/.env"),
  quiet: true,
});

interface OneshotLogLine {
  readonly error?: string;
  readonly errorName?: string;
  readonly finishedAt?: string;
  readonly payload?: EnrichOneshotPayload;
  readonly result?: EnrichIncompleteResult;
  readonly startedAt?: string;
  readonly status: "config_invalid" | "failed" | "starting" | "succeeded";
}

const log = (line: OneshotLogLine): void => {
  console.log(JSON.stringify({ task: "enrich-incomplete-oneshot", ...line }));
};

const main = async (): Promise<void> => {
  const startedAt = new Date().toISOString();
  let payload;
  try {
    payload = enrichOneshotPayloadFromEnv(process.env);
  } catch (error) {
    log({
      error: error instanceof Error ? error.message : String(error),
      status: "config_invalid",
    });
    process.exitCode = 2;
    return;
  }
  log({ payload, startedAt, status: "starting" });
  try {
    // Same function the Trigger task `enrich-incomplete` runs.
    const result = await runEnrichIncomplete(payload);
    log({
      finishedAt: new Date().toISOString(),
      result,
      startedAt,
      status: "succeeded",
    });
  } catch (error) {
    log({
      error: error instanceof Error ? error.message : String(error),
      errorName: error instanceof Error ? error.name : "NonError",
      finishedAt: new Date().toISOString(),
      startedAt,
      status: "failed",
    });
    process.exitCode = 1;
  }
};

await main();
