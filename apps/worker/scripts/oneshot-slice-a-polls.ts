import path from "node:path";

import { RunAlreadyInProgressError } from "@ji/connectors";
import { resolvePollRunStaleAfterMs } from "@ji/env/poller";
import { config as loadEnv } from "dotenv";

import {
  buildPollPayload,
  formatOneshotList,
  isSoftOrHashFailure,
  oneshotUsage,
  parseOneshotArgs,
  selectOneshotTargets,
  summarizeOneshotRun,
} from "../src/oneshot-slice-a-polls";
import type {
  OneshotResult,
  OneshotRunBronResult,
} from "../src/oneshot-slice-a-polls";
import {
  createPollBronRuntime,
  requireDatabaseUrl,
  runBronIngestPipeline,
} from "../src/poll-bron-run";
import type { BronIngestPipelineResult } from "../src/poll-bron-run";
import { listPollableSliceABronnen } from "../src/slice-a-pollable";
import type { PollBronPayload } from "../src/tasks/poll-bron-schema";

// scriptDir is apps/worker/scripts; the repo root is three levels up.
const scriptDir = import.meta.dirname;
const repoRoot = path.resolve(scriptDir, "../../..");

loadEnv({ path: path.join(repoRoot, "apps/server/.env") });
loadEnv({ override: true, path: path.join(repoRoot, "apps/worker/.env") });

const pollRunStaleAfterMs = resolvePollRunStaleAfterMs();

/**
 * Offline-capable wrapper matching Trigger `poll-bron` → `runPollBron`
 * without importing `@trigger.dev/sdk`.
 */
const runPollBronOnce = async (
  payload: PollBronPayload
): Promise<BronIngestPipelineResult> => {
  const runtime = createPollBronRuntime(requireDatabaseUrl(), {
    pollRunStaleAfterMs,
  });
  try {
    return await runBronIngestPipeline(payload, runtime, "poll");
  } finally {
    await runtime.close();
  }
};

const main = async (): Promise<OneshotResult> => {
  let args;
  try {
    args = parseOneshotArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : oneshotUsage);
    process.exit(1);
  }

  const listRuntime = createPollBronRuntime(requireDatabaseUrl(), {
    pollRunStaleAfterMs,
  });
  let pollable;
  try {
    pollable = await listPollableSliceABronnen(listRuntime);
  } finally {
    await listRuntime.close();
  }

  const targets = selectOneshotTargets(pollable, args);

  if (args.mode === "list") {
    const listed = formatOneshotList(pollable, targets);
    console.log(JSON.stringify(listed, null, 2));
    return listed;
  }

  const startedAt = new Date().toISOString();
  const bronResults: OneshotRunBronResult[] = [];
  let hardFail = false;

  /* oxlint-disable no-await-in-loop -- sequential fan-out keeps Coolify load bounded */
  for (const bron of targets) {
    const payload = buildPollPayload(bron);
    try {
      // Same body as Trigger task `poll-bron` → runPollBron (no Trigger SDK import).
      const result = await runPollBronOnce(payload);
      bronResults.push({
        bronSlug: result.bronSlug,
        metrics: result.metrics,
        nieuw: result.metrics.new,
        scrapeRunId: result.scrapeRunId,
        status: "succeeded",
        writtenRecords: result.writtenRecords,
      });
      console.log(
        JSON.stringify(
          {
            bronSlug: result.bronSlug,
            metrics: result.metrics,
            scrapeRunId: result.scrapeRunId,
            status: "succeeded",
            writtenRecords: result.writtenRecords,
          },
          null,
          2
        )
      );
    } catch (error) {
      if (error instanceof RunAlreadyInProgressError) {
        bronResults.push({
          bronSlug: bron.bronSlug,
          scrapeRunId: payload.scrapeRunId,
          skippedReason: "already_running",
          status: "skipped",
        });
        console.log(
          JSON.stringify(
            {
              bronSlug: bron.bronSlug,
              scrapeRunId: payload.scrapeRunId,
              skippedReason: "already_running",
              status: "skipped",
            },
            null,
            2
          )
        );
        continue;
      }
      const message = error instanceof Error ? error.message : String(error);
      const soft = isSoftOrHashFailure(message);
      bronResults.push({
        bronSlug: bron.bronSlug,
        error: message,
        scrapeRunId: payload.scrapeRunId,
        soft,
        status: "failed",
      });
      console.error(
        JSON.stringify(
          {
            bronSlug: bron.bronSlug,
            error: message,
            scrapeRunId: payload.scrapeRunId,
            soft,
            status: "failed",
          },
          null,
          2
        )
      );
      // Soft/hash continue; hard-fail stop so ops can investigate (CTP-489).
      if (!soft) {
        hardFail = true;
        break;
      }
    }
  }
  /* oxlint-enable no-await-in-loop */

  const summary = summarizeOneshotRun({
    finishedAt: new Date().toISOString(),
    hardFail,
    results: bronResults,
    startedAt,
    targets: targets.length,
  });

  console.log(JSON.stringify(summary, null, 2));

  // Non-zero exit on hard-fail only (soft/hash continues still exit 0 — CTP-489).
  if (summary.hardFail) {
    process.exitCode = 1;
  }
  return summary;
};

await main();
