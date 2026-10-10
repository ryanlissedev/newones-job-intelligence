import { defineConfig } from "@playwright/test";

import { readLiveJobsArtifactPolicy } from "./e2e/live-jobs/artifact-policy";

const baseUse = {
  ...readLiveJobsArtifactPolicy(),
  viewport: { height: 960, width: 1440 },
};

const withBaseUrl = process.env.E2E_BASE_URL
  ? { ...baseUse, baseURL: process.env.E2E_BASE_URL }
  : baseUse;
const use = process.env.E2E_STORAGE_STATE
  ? { ...withBaseUrl, storageState: process.env.E2E_STORAGE_STATE }
  : withBaseUrl;

export default defineConfig({
  expect: { timeout: 15_000 },
  forbidOnly: true,
  fullyParallel: false,
  outputDir: ".artifacts/e2e/live-jobs/mutations",
  reporter: "line",
  retries: 0,
  testDir: "./e2e/live-jobs",
  testMatch: /mutations\.playwright\.ts$/u,
  timeout: 60_000,
  use,
  workers: 1,
});
