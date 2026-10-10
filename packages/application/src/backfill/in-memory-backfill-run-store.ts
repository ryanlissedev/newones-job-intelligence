import type {
  BackfillFailureEvidence,
  BackfillRunEvidence,
  BackfillRunMetrics,
  BackfillRunStore,
} from "./neon-v1-types";

export class InMemoryBackfillRunStore implements BackfillRunStore {
  readonly runs: {
    evidence?: BackfillRunEvidence;
    failure?: BackfillFailureEvidence;
    metrics?: BackfillRunMetrics;
    reason?: string;
    scrapeRunId: string;
    status: "failed" | "running" | "succeeded";
  }[] = [];

  startRun(_bronId: string): Promise<{ scrapeRunId: string }> {
    const scrapeRunId = crypto.randomUUID();
    this.runs.push({ scrapeRunId, status: "running" });
    return Promise.resolve({ scrapeRunId });
  }

  completeRun(
    scrapeRunId: string,
    evidence: BackfillRunEvidence
  ): Promise<void> {
    const run = this.runs.find((entry) => entry.scrapeRunId === scrapeRunId);
    if (run) {
      run.evidence = evidence;
      run.metrics = evidence.metrics;
      run.status = "succeeded";
    }
    return Promise.resolve();
  }

  failRun(
    scrapeRunId: string,
    failure: BackfillFailureEvidence,
    evidence: BackfillRunEvidence
  ): Promise<void> {
    const run = this.runs.find((entry) => entry.scrapeRunId === scrapeRunId);
    if (run) {
      run.evidence = evidence;
      run.failure = failure;
      run.metrics = evidence.metrics;
      run.reason = `Backfill failed during ${failure.phase}`;
      run.status = "failed";
    }
    return Promise.resolve();
  }
}
