import { defineConfig } from "@playwright/test";

import { readLiveJobsArtifactPolicy } from "./e2e/live-jobs/artifact-policy";

export default defineConfig({
  expect: { timeout: 15_000 },
  forbidOnly: true,
  fullyParallel: false,
  outputDir: ".artifacts/e2e/live-jobs/anonymous",
  reporter: "line",
  retries: 0,
  testDir: "./e2e/live-jobs",
  testMatch: /(?:anonymous|bron-dashboard-anonymous)\.playwright\.ts$/u,
  timeout: 60_000,
  use: {
    ...readLiveJobsArtifactPolicy(),
    viewport: { height: 960, width: 1440 },
  },
  workers: 1,
});
