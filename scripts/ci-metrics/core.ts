export interface WorkflowRunInput {
  id: number;
  run_attempt: number;
  status: string;
  conclusion: string | null;
  head_sha: string;
  created_at: string | null;
  run_started_at: string | null;
  updated_at: string | null;
  html_url: string;
  jobs_url: string;
}

export interface WorkflowStepInput {
  name: string;
  status: string;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
  number: number;
}

export interface WorkflowJobInput {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
  html_url: string;
  steps?: WorkflowStepInput[];
}

export interface DurationMetric {
  durationMs: number | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface WorkflowMetrics {
  schemaVersion: 1;
  collectedAt: string;
  run: {
    id: number;
    attempt: number;
    status: string;
    conclusion: string | null;
    sha: string;
    url: string;
    jobsApiUrl: string;
  };
  timing: {
    queuePendingMs: number | null;
    executionCriticalPathMs: number | null;
    endToEndMs: number | null;
    jobComputeSumMs: number;
    timeToFirstFailureMs: number | null;
    firstFailureSource: string | null;
  };
  jobs: (DurationMetric & {
    id: number;
    name: string;
    status: string;
    conclusion: string | null;
    url: string;
    steps: (DurationMetric & {
      number: number;
      name: string;
      status: string;
      conclusion: string | null;
    })[];
  })[];
  notes: string[];
}

// These terminal conclusions prove an execution failure. Action-required,
// neutral, skipped, cancelled, and stale runs intentionally do not.
const provenFailureConclusions = new Set([
  "failure",
  "startup_failure",
  "timed_out",
]);

const isProvenFailureConclusion = (conclusion: string | null): boolean =>
  conclusion !== null && provenFailureConclusions.has(conclusion);

const timestamp = (value: string | null | undefined): number | null => {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
};

const duration = (
  startedAt: string | null | undefined,
  completedAt: string | null | undefined
): number | null => {
  const started = timestamp(startedAt);
  const completed = timestamp(completedAt);
  if (started === null || completed === null || completed < started) {
    return null;
  }
  return completed - started;
};

const hasCompletedJobWithoutCompletionTimestamp = (
  jobs: WorkflowJobInput[]
): boolean =>
  jobs.some(
    (job) => job.status === "completed" && timestamp(job.completed_at) === null
  );

const workflowCompletionBoundary = (run: WorkflowRunInput): number | null =>
  run.status === "completed" ? timestamp(run.updated_at) : null;

const lastCompletionBoundary = (
  run: WorkflowRunInput,
  jobCompletions: number[],
  hasMissingCompletion: boolean
): number | null => {
  if (hasMissingCompletion) {
    return workflowCompletionBoundary(run);
  }
  if (jobCompletions.length === 0) {
    return workflowCompletionBoundary(run);
  }
  return Math.max(...jobCompletions);
};

const elapsed = (
  started: number | null,
  completed: number | null
): number | null =>
  started === null || completed === null || completed < started
    ? null
    : completed - started;

interface AttemptBoundary {
  elapsedBoundary: number | null;
  note: string | null;
  queueBoundary: number | null;
}

interface FailureCandidate {
  at: number;
  source: string;
}

const workflowFailureCandidates = (
  run: WorkflowRunInput,
  completionBoundary: number | null
): FailureCandidate[] => {
  if (
    !isProvenFailureConclusion(run.conclusion) ||
    completionBoundary === null
  ) {
    return [];
  }
  return [{ at: completionBoundary, source: "workflow run" }];
};

const attemptBoundary = (
  run: WorkflowRunInput,
  firstJobStart: number | null
): AttemptBoundary => {
  const created = timestamp(run.created_at);
  if (run.run_attempt === 1) {
    return {
      elapsedBoundary: created,
      note: null,
      queueBoundary: created,
    };
  }

  const runStarted = timestamp(run.run_started_at);
  const runStartedPrecedesJobs =
    runStarted !== null &&
    (firstJobStart === null || runStarted <= firstJobStart);
  if (runStartedPrecedesJobs) {
    return {
      elapsedBoundary: runStarted,
      note: "Rerun timing is anchored at run_started_at for this attempt; the workflow's original created_at is intentionally excluded.",
      queueBoundary: runStarted,
    };
  }
  if (firstJobStart !== null) {
    return {
      elapsedBoundary: firstJobStart,
      note: "Rerun run_started_at was missing or later than the first attempt-specific job start. End-to-end and failure timing fall back to that first job start; queue/pending is unavailable rather than estimated.",
      queueBoundary: null,
    };
  }
  return {
    elapsedBoundary: null,
    note: "Rerun run_started_at was not a trustworthy attempt boundary and no attempt-specific job start was available; boundary-dependent timings remain unavailable.",
    queueBoundary: null,
  };
};

export const calculateWorkflowMetrics = (
  run: WorkflowRunInput,
  inputJobs: WorkflowJobInput[],
  collectedAt = new Date().toISOString(),
  jobsApiUrl = run.jobs_url
): WorkflowMetrics => {
  const jobs = inputJobs.map((job) => ({
    completedAt: job.completed_at,
    conclusion: job.conclusion,
    durationMs: duration(job.started_at, job.completed_at),
    id: job.id,
    name: job.name,
    startedAt: job.started_at,
    status: job.status,
    steps: (job.steps ?? []).map((step) => ({
      completedAt: step.completed_at,
      conclusion: step.conclusion,
      durationMs: duration(step.started_at, step.completed_at),
      name: step.name,
      number: step.number,
      startedAt: step.started_at,
      status: step.status,
    })),
    url: job.html_url,
  }));

  const jobStarts = jobs
    .map((job) => timestamp(job.startedAt))
    .filter((value): value is number => value !== null);
  const jobCompletions = jobs
    .map((job) => timestamp(job.completedAt))
    .filter((value): value is number => value !== null);
  const hasCompletedJobWithoutCompletion =
    hasCompletedJobWithoutCompletionTimestamp(inputJobs);
  const firstJobStart =
    jobStarts.length > 0
      ? Math.min(...jobStarts)
      : timestamp(run.run_started_at);
  const workflowCompletion = workflowCompletionBoundary(run);
  const lastJobCompletion = lastCompletionBoundary(
    run,
    jobCompletions,
    hasCompletedJobWithoutCompletion
  );
  const boundary = attemptBoundary(run, firstJobStart);

  const failureCandidates = workflowFailureCandidates(run, workflowCompletion);
  for (const job of jobs) {
    for (const step of job.steps) {
      const failedAt = timestamp(step.completedAt);
      if (isProvenFailureConclusion(step.conclusion) && failedAt !== null) {
        failureCandidates.push({
          at: failedAt,
          source: `${job.name} / ${step.name}`,
        });
      }
    }
    const failedAt = timestamp(job.completedAt);
    if (isProvenFailureConclusion(job.conclusion) && failedAt !== null) {
      failureCandidates.push({ at: failedAt, source: job.name });
    }
  }
  failureCandidates.sort((left, right) => left.at - right.at);
  const firstFailure = failureCandidates[0] ?? null;

  const missingDurationCount = jobs.filter(
    (job) => job.durationMs === null
  ).length;
  const notes = [
    "executionCriticalPathMs is elapsed workflow execution from the first job start to the last job completion; jobComputeSumMs sums job durations and can be larger when jobs run in parallel.",
  ];
  if (boundary.note) {
    notes.push(boundary.note);
  }
  if (missingDurationCount > 0) {
    notes.push(
      `${missingDurationCount} job(s) lacked a complete timestamp pair and were excluded from jobComputeSumMs.`
    );
  }
  if (hasCompletedJobWithoutCompletion) {
    notes.push(
      workflowCompletion === null
        ? "At least one completed job lacked completed_at and no workflow completion boundary was available; execution and end-to-end timing remain unavailable rather than understated."
        : "At least one completed job lacked completed_at; execution and end-to-end timing use the workflow updated_at completion boundary rather than an understated partial job boundary."
    );
  }
  if (run.conclusion === "cancelled") {
    notes.push(
      "The workflow was cancelled; incomplete durations remain null rather than being estimated."
    );
  }

  return {
    collectedAt,
    jobs,
    notes,
    run: {
      attempt: run.run_attempt,
      conclusion: run.conclusion,
      id: run.id,
      jobsApiUrl,
      sha: run.head_sha,
      status: run.status,
      url: run.html_url,
    },
    schemaVersion: 1,
    timing: {
      endToEndMs: elapsed(boundary.elapsedBoundary, lastJobCompletion),
      executionCriticalPathMs: elapsed(firstJobStart, lastJobCompletion),
      firstFailureSource: firstFailure?.source ?? null,
      jobComputeSumMs: jobs.reduce(
        (total, job) => total + (job.durationMs ?? 0),
        0
      ),
      queuePendingMs: elapsed(boundary.queueBoundary, firstJobStart),
      timeToFirstFailureMs:
        firstFailure === null
          ? null
          : elapsed(boundary.elapsedBoundary, firstFailure.at),
    },
  };
};

const formatDuration = (value: number | null): string => {
  if (value === null) {
    return "n/a";
  }
  return value < 1000 ? `${value} ms` : `${(value / 1000).toFixed(2)} s`;
};

const escapeCell = (value: string): string =>
  value.replaceAll("|", "\\|").replaceAll(/\r?\n/gu, " ");

export const renderWorkflowMetricsMarkdown = (
  metrics: WorkflowMetrics
): string => {
  const jobRows = metrics.jobs
    .map(
      (job) =>
        `| ${escapeCell(job.name)} | ${job.status} | ${job.conclusion ?? "n/a"} | ${formatDuration(job.durationMs)} |`
    )
    .join("\n");
  const stepRows = metrics.jobs
    .flatMap((job) =>
      job.steps.map(
        (step) =>
          `| ${escapeCell(job.name)} | ${escapeCell(step.name)} | ${step.status} | ${step.conclusion ?? "n/a"} | ${formatDuration(step.durationMs)} |`
      )
    )
    .join("\n");

  return `# CI workflow timing

Run [${metrics.run.id}](${metrics.run.url}) (attempt ${metrics.run.attempt}) at \`${metrics.run.sha}\`: **${metrics.run.conclusion ?? metrics.run.status}**

| Metric | Duration |
| --- | ---: |
| Queue / pending | ${formatDuration(metrics.timing.queuePendingMs)} |
| Execution / critical-path elapsed | ${formatDuration(metrics.timing.executionCriticalPathMs)} |
| End-to-end | ${formatDuration(metrics.timing.endToEndMs)} |
| Job compute sum | ${formatDuration(metrics.timing.jobComputeSumMs)} |
| Time to first proven failure | ${formatDuration(metrics.timing.timeToFirstFailureMs)} |

First failure source: ${metrics.timing.firstFailureSource ? escapeCell(metrics.timing.firstFailureSource) : "n/a"}

## Jobs

| Job | Status | Conclusion | Duration |
| --- | --- | --- | ---: |
${jobRows || "| No jobs returned | n/a | n/a | n/a |"}

## Steps

| Job | Step | Status | Conclusion | Duration |
| --- | --- | --- | --- | ---: |
${stepRows || "| No steps returned | n/a | n/a | n/a | n/a |"}

${metrics.notes.map((note) => `> ${note}`).join("\n")}
`;
};
