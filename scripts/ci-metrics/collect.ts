#!/usr/bin/env bun
import { mkdir, rename } from "node:fs/promises";
import path from "node:path";

import {
  calculateWorkflowMetrics,
  renderWorkflowMetricsMarkdown,
} from "./core";
import type { WorkflowJobInput, WorkflowRunInput } from "./core";

interface WorkflowEvent {
  workflow_run: WorkflowRunInput;
  repository: { full_name: string };
}

interface JobsResponse {
  jobs: WorkflowJobInput[];
}

interface AttemptJobsResult {
  jobs: WorkflowJobInput[];
  jobsApiUrl: string;
}

type FetchJobsRequest = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

const requiredEnvironment = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
};

export const buildAttemptJobsApiUrl = (
  repository: string,
  runId: number,
  runAttempt: number,
  page: number
): string =>
  `https://api.github.com/repos/${repository}/actions/runs/${runId}/attempts/${runAttempt}/jobs?per_page=100&page=${page}`;

export const fetchWorkflowAttemptJobs = async (
  repository: string,
  runId: number,
  runAttempt: number,
  token: string,
  request: FetchJobsRequest = fetch
): Promise<AttemptJobsResult> => {
  const jobs: WorkflowJobInput[] = [];
  const jobsApiUrl = buildAttemptJobsApiUrl(repository, runId, runAttempt, 1);
  for (let page = 1; ; page += 1) {
    const url = buildAttemptJobsApiUrl(repository, runId, runAttempt, page);
    // oxlint-disable-next-line eslint/no-await-in-loop -- pagination is sequential by contract
    const response = await request(url, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "catapulze-ci-metrics",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!response.ok) {
      throw new Error(`GitHub jobs API returned ${response.status}`);
    }
    // SAFETY: GitHub's versioned Actions jobs endpoint owns this response contract.
    // oxlint-disable-next-line eslint/no-await-in-loop -- this parses the sequential page response
    const body = (await response.json()) as JobsResponse;
    jobs.push(...body.jobs);
    if (body.jobs.length < 100) {
      return { jobs, jobsApiUrl };
    }
  }
};

const atomicWrite = async (
  destination: string,
  content: string
): Promise<void> => {
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
  await Bun.write(temporary, content);
  await rename(temporary, destination);
};

const main = async (): Promise<void> => {
  const eventPath = requiredEnvironment("GITHUB_EVENT_PATH");
  const token = requiredEnvironment("GITHUB_TOKEN");
  const outputDirectory = process.env.CI_METRICS_DIR ?? ".artifacts/ci-metrics";
  // SAFETY: Actions owns GITHUB_EVENT_PATH for this workflow_run trigger;
  // required top-level fields are guarded immediately below before use.
  const event = (await Bun.file(eventPath).json()) as WorkflowEvent;
  if (!event.workflow_run || !event.repository?.full_name) {
    throw new Error("workflow_run event payload is incomplete");
  }

  const { jobs, jobsApiUrl } = await fetchWorkflowAttemptJobs(
    event.repository.full_name,
    event.workflow_run.id,
    event.workflow_run.run_attempt,
    token
  );
  const metrics = calculateWorkflowMetrics(
    event.workflow_run,
    jobs,
    undefined,
    jobsApiUrl
  );
  const stem = `ci-run-${metrics.run.id}-attempt-${metrics.run.attempt}`;
  const jsonPath = path.join(outputDirectory, `${stem}.json`);
  const markdownPath = path.join(outputDirectory, `${stem}.md`);
  const markdown = renderWorkflowMetricsMarkdown(metrics);
  await atomicWrite(jsonPath, `${JSON.stringify(metrics, null, 2)}\n`);
  await atomicWrite(markdownPath, markdown);

  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    await Bun.write(summaryPath, markdown);
  }
  process.stdout.write(`${jsonPath}\n${markdownPath}\n`);
};

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`ci-metrics: ${message}\n`);
    process.exit(1);
  }
}
