import { defineConfig } from "@playwright/test";

import { readLiveJobsArtifactPolicy } from "./e2e/live-jobs/artifact-policy";

const baseUse = {
  ...readLiveJobsArtifactPolicy(),
  viewport: { height: 960, width: 1440 },
};

const use = process.env.E2E_BASE_URL
  ? {
      ...baseUse,
      baseURL: process.env.E2E_BASE_URL,
      storageState: process.env.E2E_STORAGE_STATE,
    }
  : baseUse;

export default defineConfig({
  expect: { timeout: 15_000 },
  forbidOnly: true,
  fullyParallel: false,
  outputDir: ".artifacts/e2e/live-jobs/read-only",
  reporter: "line",
  retries: 0,
  testDir: "./e2e/live-jobs",
  testMatch: /(?:read-only|bron-dashboard)\.playwright\.ts$/u,
  timeout: 60_000,
  use,
  workers: 1,
});
