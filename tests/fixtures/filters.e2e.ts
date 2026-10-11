import { expect } from "e2e";

import { openReadyJobs } from "./support/helpers";
import { test } from "./support/test";

test(
  "source and contract filters combine, persist, and clear",
  { tags: ["filters"] },
  async ({ app, browser, screen }) => {
    await openReadyJobs(app, screen);
    await screen.getByRole("checkbox", "Inhuurdesk 4").check();
    await expect(screen.getByText("4 resultaten")).toBeVisible();
    expect(new URL(await browser.url()).searchParams.get("source")).toBe(
      "inhuurdesk"
    );
    await expect(
      screen.getByRole("button", "Bron Inhuurdesk verwijderen")
    ).toBeVisible();

    await screen.getByRole("checkbox", /Interim i \d+/u).check();
    await expect(screen.getByText("4 resultaten")).toBeVisible();
    expect(new URL(await browser.url()).searchParams.get("contract")).toBe(
      "interim"
    );
    await screen.getByRole("checkbox", /^Amsterdam \d+$/u).check();
    await expect(screen.getByText("2 resultaten")).toBeVisible();
    expect(new URL(await browser.url()).searchParams.get("location")).toBe(
      "Amsterdam"
    );
    await browser.reload();
    await expect(screen.getByText("2 resultaten")).toBeVisible();
    await expect(screen.getByRole("checkbox", "Inhuurdesk 4")).toBeChecked();
    await expect(screen.getByRole("checkbox", /Interim i \d+/u)).toBeChecked();

    await screen.getByTestId("job-filters-clear-all").nth(0).tap();
    await expect(screen.getByText("20 resultaten")).toBeVisible();
    expect(new URL(await browser.url()).search).toBe("");
  }
);
