import { describe, expect, test } from "bun:test";

import { buildAttemptJobsApiUrl, fetchWorkflowAttemptJobs } from "./collect";
import earlierAttempt from "./fixtures/jobs-attempt-1.json";
import requestedAttempt from "./fixtures/jobs-attempt-2.json";

describe("attempt-specific workflow jobs", () => {
  test("builds the attempt endpoint without the all-attempts filter", () => {
    const url = buildAttemptJobsApiUrl("acme/repo", 42, 3, 1);

    expect(url).toBe(
      "https://api.github.com/repos/acme/repo/actions/runs/42/attempts/3/jobs?per_page=100&page=1"
    );
    expect(url).not.toContain("filter=all");
  });

  test("fetches only the requested attempt and excludes earlier jobs", async () => {
    const expectedUrl =
      "https://api.github.com/repos/acme/repo/actions/runs/42/attempts/2/jobs?per_page=100&page=1";
    const requestedUrls: string[] = [];
    const request = (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      requestedUrls.push(url);
      if (!url.includes("/attempts/2/jobs")) {
        return Promise.reject(new Error(`unexpected non-attempt URL: ${url}`));
      }
      return Promise.resolve(Response.json(requestedAttempt));
    };

    const result = await fetchWorkflowAttemptJobs(
      "acme/repo",
      42,
      2,
      "test-token",
      request
    );

    expect(requestedUrls).toEqual([expectedUrl]);
    expect(result.jobs.map(({ id }) => id)).toEqual([201]);
    expect(result.jobs.map(({ id }) => id)).not.toContain(
      earlierAttempt.jobs[0]?.id
    );
    expect(result.jobsApiUrl).toBe(expectedUrl);
  });
});
