import { RunOwnershipLostError } from "@ji/connectors";
import { describeCauseChain, errorNameOf } from "@ji/db/error-cause-chain";
import type { BronId, ScrapeRunId } from "@ji/domain";

import type { SliceABronSlug } from "../slice-a-bronnen";
import { redactErrorMessage } from "./source-log";

export const reportTelemetryCallback = async <Value>(
  callback: ((value: Value) => Promise<void> | void) | undefined,
  value: Value,
  context: {
    bronId: BronId;
    bronSlug: SliceABronSlug;
    scrapeRunId: ScrapeRunId;
    telemetryPhase:
      | "connector_progress"
      | "curation_progress"
      | "curation_started";
  },
  signal?: AbortSignal
): Promise<void> => {
  if (!callback) {
    return;
  }
  try {
    // The callback may reject; await it here so the catch isolates observer failures.
    // oxlint-disable-next-line promise/prefer-await-to-callbacks
    return await callback(value);
  } catch (error) {
    if (error instanceof RunOwnershipLostError) {
      throw error;
    }
    if (signal?.aborted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new DOMException("Aborted", "AbortError");
    }
    // Telemetry is observational. A callback failure must not turn committed
    // connector or curation work into a failed/parked run.
    process.stderr.write(
      `${JSON.stringify({
        ...context,
        errorMessage: redactErrorMessage(describeCauseChain({ error })),
        errorName: errorNameOf({ error }),
        event: "poll_telemetry_callback_failed",
      })}\n`
    );
  }
};
