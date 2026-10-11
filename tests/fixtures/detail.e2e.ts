import { expect } from "e2e";

import { openReadyJobs } from "./support/helpers";
import { test } from "./support/test";

test(
  "opening a result shows provenance and closing removes the job URL state",
  { tags: ["detail"] },
  async ({ app, browser, screen }) => {
    await openReadyJobs(app, screen);
    await screen.getByRole("button", "Senior Data Engineer").tap();
    await expect(
      screen.getByRole("heading", "Senior Data Engineer", { level: 2 })
    ).toBeVisible();
    await expect(
      screen.getByRole("heading", "Herkomst", { level: 3 })
    ).toBeVisible();
    await expect(
      screen.getByRole("link", "Open bronrecord AMS-2026-184")
    ).toBeVisible();
    expect(new URL(await browser.url()).searchParams.get("job")).toBe(
      "job-001"
    );
    await screen.getByRole("button", "Vacaturedetail sluiten").tap();
    await expect(
      screen.getByRole("heading", "Senior Data Engineer", { level: 2 })
    ).toBeHidden();
    expect(new URL(await browser.url()).searchParams.get("job")).toBeNull();
  }
);

test(
  "a job deep link opens directly and browser back closes it",
  { tags: ["detail"] },
  async ({ app, browser, screen }) => {
    await app.open("/jobs?job=job-001");
    await expect(
      screen.getByRole("heading", "Senior Data Engineer", { level: 2 })
    ).toBeVisible();
    await browser.back();
    await expect(
      screen.getByRole("heading", "Senior Data Engineer", { level: 2 })
    ).toBeHidden();
  }
);
