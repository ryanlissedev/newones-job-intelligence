import path from "node:path";

import { defineConfig } from "@playwright/test";

const artifactsRoot = path.resolve(import.meta.dirname, "../../.artifacts/e2e");

export default defineConfig({
  expect: { timeout: 15_000 },
  forbidOnly: true,
  fullyParallel: false,
  outputDir: path.join(artifactsRoot, "field-gap"),
  projects: [
    { name: "setup", testMatch: /field-gap\.setup\.ts$/u },
    {
      dependencies: ["setup"],
      name: "field-gap",
      testMatch: /field-gap\.playwright\.ts$/u,
      use: { storageState: path.join(artifactsRoot, "field-gap-auth.json") },
    },
  ],
  reporter: [
    ["line"],
    [
      "json",
      { outputFile: path.join(artifactsRoot, "field-gap-results.json") },
    ],
    [
      "html",
      {
        open: "never",
        outputFolder: path.join(artifactsRoot, "field-gap-report"),
      },
    ],
  ],
  retries: 0,
  testDir: ".",
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
