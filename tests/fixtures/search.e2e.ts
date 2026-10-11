import { expect } from "e2e";

import { openReadyJobs } from "./support/helpers";
import { test } from "./support/test";

test(
  "a Boolean query narrows results and is reflected in the URL",
  { tags: ["search"] },
  async ({ app, browser, screen }) => {
    await openReadyJobs(app, screen);
    await screen
      .getByRole("textbox", "Zoek opdrachten met Boolean-logica")
      .fill("Azure AND data");
    await screen.getByRole("button", "Zoeken").tap();
    await expect(
      screen.getByRole("button", "Senior Data Engineer")
    ).toBeVisible();
    await expect(screen.getByText("1 resultaten")).toBeVisible();
    expect(new URL(await browser.url()).searchParams.get("q")).toBe(
      "Azure AND data"
    );
  }
);

test(
  "a deep-linked Boolean query restores the same result",
  { tags: ["search"] },
  async ({ app, screen }) => {
    await app.open("/jobs?q=Azure%20AND%20data");
    await expect(
      screen.getByRole("button", "Senior Data Engineer")
    ).toBeVisible();
    await expect(screen.getByText("1 resultaten")).toBeVisible();
  }
);

test(
  "a malformed Boolean query shows the syntax-error state",
  { tags: ["search"] },
  async ({ app, screen }) => {
    await app.open("/jobs?q=%28Azure");
    await expect(
      screen.getByRole("heading", "Boolean-query klopt nog niet", { level: 2 })
    ).toBeVisible();
  }
);

test(
  "a query with no matches shows the empty state",
  { tags: ["search"] },
  async ({ app, screen }) => {
    await app.open("/jobs?q=unicorn");
    await expect(
      screen.getByRole("heading", "Geen opdrachten gevonden", { level: 2 })
    ).toBeVisible();
  }
);
