import path from "node:path";

import { defineConfig } from "@playwright/test";

const artifactsRoot = path.resolve(
  import.meta.dirname,
  "../../.cursor/skills/verify-job-intelligence/artifacts"
);

export default defineConfig({
  expect: { timeout: 15_000 },
  forbidOnly: true,
  fullyParallel: false,
  outputDir: path.join(artifactsRoot, "marktvragen"),
  reporter: [["line"]],
  retries: 0,
  testDir: ".",
  testMatch: /marktvragen\.playwright\.ts$/u,
  timeout: 90_000,
  use: {
    baseURL: "http://localhost:3001",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: { mode: "on", size: { height: 960, width: 1440 } },
  },
});
