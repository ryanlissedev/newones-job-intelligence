import { describe, expect, test } from "bun:test";

import {
  calculateWorkflowMetrics,
  renderWorkflowMetricsMarkdown,
} from "./core";
import type { WorkflowJobInput, WorkflowRunInput } from "./core";
import delayedRerun from "./fixtures/delayed-rerun-attempt-2.json";

const run = (overrides: Partial<WorkflowRunInput> = {}): WorkflowRunInput => ({
  conclusion: "success",
  created_at: "2026-08-28T10:00:00.000Z",
  head_sha: "abc123",
  html_url: "https://github.com/acme/repo/actions/runs/42",
  id: 42,
  jobs_url: "https://api.github.com/repos/acme/repo/actions/runs/42/jobs",
  run_attempt: 1,
  run_started_at: "2026-08-28T10:01:00.000Z",
  status: "completed",
  updated_at: "2026-08-28T10:12:00.000Z",
  ...overrides,
});

const job = (overrides: Partial<WorkflowJobInput> = {}): WorkflowJobInput => ({
  completed_at: "2026-08-28T10:11:00.000Z",
  conclusion: "success",
  html_url: "https://github.com/acme/repo/actions/runs/42/job/1",
  id: 1,
  name: "verify",
  started_at: "2026-08-28T10:01:00.000Z",
  status: "completed",
  steps: [],
  ...overrides,
});

describe("workflow timing metrics", () => {
  test("measures a successful workflow", () => {
    const metrics = calculateWorkflowMetrics(
      run(),
      [job()],
      "2026-08-28T10:13:00.000Z"
    );
    expect(metrics.timing).toEqual({
      endToEndMs: 660_000,
      executionCriticalPathMs: 600_000,
      firstFailureSource: null,
      jobComputeSumMs: 600_000,
      queuePendingMs: 60_000,
      timeToFirstFailureMs: null,
    });
    expect(renderWorkflowMetricsMarkdown(metrics)).toContain("Job compute sum");
  });

  test("preserves attempt metadata and the attempt-specific jobs URL", () => {
    const jobsApiUrl =
      "https://api.github.com/repos/acme/repo/actions/runs/42/attempts/3/jobs?per_page=100&page=1";
    const metrics = calculateWorkflowMetrics(
      run({ run_attempt: 3 }),
      [job()],
      "2026-08-28T10:13:00.000Z",
      jobsApiUrl
    );

    expect(metrics.run.attempt).toBe(3);
    expect(metrics.run.jobsApiUrl).toBe(jobsApiUrl);
  });

  test("anchors a delayed rerun to its attempt-specific start", () => {
    const jobsApiUrl =
      "https://api.github.com/repos/acme/repo/actions/runs/42/attempts/2/jobs?per_page=100&page=1";
    const metrics = calculateWorkflowMetrics(
      delayedRerun.workflowRun,
      delayedRerun.jobs,
      "2026-08-28T11:09:00.000Z",
      jobsApiUrl
    );

    expect(metrics.timing.queuePendingMs).toBe(120_000);
    expect(metrics.timing.endToEndMs).toBe(360_000);
    expect(metrics.timing.timeToFirstFailureMs).toBe(300_000);
    expect(metrics.run.jobsApiUrl).toBe(jobsApiUrl);
    expect(metrics.notes.join(" ")).toContain(
      "original created_at is intentionally excluded"
    );
    expect(renderWorkflowMetricsMarkdown(metrics)).toContain(
      "Rerun timing is anchored at run_started_at"
    );
  });

  test("uses an honest rerun fallback without negative queue timing", () => {
    const metrics = calculateWorkflowMetrics(
      run({
        conclusion: "failure",
        run_attempt: 2,
        run_started_at: "2026-08-28T10:07:00.000Z",
      }),
      [
        job({
          completed_at: "2026-08-28T10:06:00.000Z",
          conclusion: "failure",
        }),
      ]
    );

    expect(metrics.timing.queuePendingMs).toBeNull();
    expect(metrics.timing.endToEndMs).toBe(300_000);
    expect(metrics.timing.timeToFirstFailureMs).toBe(300_000);
    expect(metrics.notes.join(" ")).toContain(
      "queue/pending is unavailable rather than estimated"
    );
  });

  test("reports the first proven failed step", () => {
    const failed = job({
      completed_at: "2026-08-28T10:06:00.000Z",
      conclusion: "failure",
      steps: [
        {
          completed_at: "2026-08-28T10:05:00.000Z",
          conclusion: "failure",
          name: "Tests",
          number: 3,
          started_at: "2026-08-28T10:02:00.000Z",
          status: "completed",
        },
      ],
    });
    const metrics = calculateWorkflowMetrics(run({ conclusion: "failure" }), [
      failed,
    ]);
    expect(metrics.timing.timeToFirstFailureMs).toBe(300_000);
    expect(metrics.timing.firstFailureSource).toBe("verify / Tests");
  });

  test.each(["failure", "timed_out", "startup_failure"])(
    "treats %s as a proven failure conclusion",
    (conclusion) => {
      const metrics = calculateWorkflowMetrics(run({ conclusion }), [
        job({ conclusion }),
      ]);

      expect(metrics.timing.timeToFirstFailureMs).toBe(660_000);
      expect(metrics.timing.firstFailureSource).toBe("verify");
    }
  );

  test.each(["action_required", "neutral", "skipped", "cancelled", "stale"])(
    "does not treat %s as a proven failure conclusion",
    (conclusion) => {
      const metrics = calculateWorkflowMetrics(run({ conclusion }), [
        job({ conclusion }),
      ]);

      expect(metrics.timing.timeToFirstFailureMs).toBeNull();
      expect(metrics.timing.firstFailureSource).toBeNull();
    }
  );

  test("separates parallel critical-path elapsed from compute sum", () => {
    const metrics = calculateWorkflowMetrics(run(), [
      job({
        completed_at: "2026-08-28T10:11:00.000Z",
        id: 1,
        name: "test",
      }),
      job({
        completed_at: "2026-08-28T10:16:00.000Z",
        id: 2,
        name: "build",
        started_at: "2026-08-28T10:06:00.000Z",
      }),
    ]);
    expect(metrics.timing.executionCriticalPathMs).toBe(900_000);
    expect(metrics.timing.jobComputeSumMs).toBe(1_200_000);
  });

  test("keeps missing timestamps and cancelled durations explicit", () => {
    const metrics = calculateWorkflowMetrics(
      run({ conclusion: "cancelled", updated_at: "2026-08-28T10:04:00.000Z" }),
      [job({ completed_at: null, conclusion: "cancelled" })]
    );
    expect(metrics.jobs[0]?.durationMs).toBeNull();
    expect(metrics.timing.executionCriticalPathMs).toBe(180_000);
    expect(metrics.timing.jobComputeSumMs).toBe(0);
    expect(metrics.notes.join(" ")).toContain("cancelled");
    expect(metrics.notes.join(" ")).toContain("excluded");
  });

  test("uses the workflow completion boundary when one completed job lacks completed_at", () => {
    const metrics = calculateWorkflowMetrics(run(), [
      job({ completed_at: "2026-08-28T10:05:00.000Z", id: 1, name: "fast" }),
      job({ completed_at: null, id: 2, name: "missing completion" }),
    ]);

    expect(metrics.timing.executionCriticalPathMs).toBe(660_000);
    expect(metrics.timing.endToEndMs).toBe(720_000);
    expect(metrics.notes.join(" ")).toContain(
      "workflow updated_at completion boundary"
    );
  });

  test("makes end timing unavailable when a completed job and workflow lack completion", () => {
    const metrics = calculateWorkflowMetrics(
      run({ status: "in_progress", updated_at: null }),
      [
        job({ completed_at: "2026-08-28T10:05:00.000Z", id: 1, name: "fast" }),
        job({ completed_at: null, id: 2, name: "missing completion" }),
      ]
    );

    expect(metrics.timing.executionCriticalPathMs).toBeNull();
    expect(metrics.timing.endToEndMs).toBeNull();
    expect(metrics.notes.join(" ")).toContain(
      "remain unavailable rather than understated"
    );
  });

  test("keeps in-progress jobless workflow end timing unavailable", () => {
    const metrics = calculateWorkflowMetrics(
      run({ conclusion: null, status: "in_progress" }),
      []
    );

    expect(metrics.timing.executionCriticalPathMs).toBeNull();
    expect(metrics.timing.endToEndMs).toBeNull();
  });

  test("reports a completed jobless startup failure at the workflow boundary", () => {
    const metrics = calculateWorkflowMetrics(
      run({ conclusion: "startup_failure" }),
      []
    );

    expect(metrics.timing.timeToFirstFailureMs).toBe(720_000);
    expect(metrics.timing.firstFailureSource).toBe("workflow run");
  });

  test("returns null when no trustworthy timing boundary exists", () => {
    const metrics = calculateWorkflowMetrics(
      run({ created_at: null, run_started_at: null, updated_at: null }),
      [job({ completed_at: null, started_at: null })]
    );
    expect(metrics.timing.queuePendingMs).toBeNull();
    expect(metrics.timing.executionCriticalPathMs).toBeNull();
    expect(metrics.timing.endToEndMs).toBeNull();
  });
});
