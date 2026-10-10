import path from "node:path";

import { defineConfig } from "@playwright/test";

const artifactsRoot = path.resolve(import.meta.dirname, "../../.artifacts/e2e");

export default defineConfig({
  expect: { timeout: 15_000 },
  forbidOnly: true,
  fullyParallel: false,
  outputDir: path.join(artifactsRoot, "search-audit"),
  reporter: [
    ["line"],
    [
      "html",
      {
        open: "never",
        outputFolder: path.join(artifactsRoot, "search-audit-report"),
      },
    ],
  ],
  retries: 0,
  testDir: ".",
  testMatch: /search-audit\.playwright\.ts$/u,
  timeout: 90_000,
  use: {
    baseURL: "http://localhost:3001",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: { mode: "on", size: { height: 960, width: 1440 } },
    viewport: { height: 960, width: 1440 },
  },
  workers: 1,
});
