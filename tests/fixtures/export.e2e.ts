import { expect } from "e2e";

import { openReadyJobs } from "./support/helpers";
import { test } from "./support/test";

test(
  "a selected result can be snapshotted, approved, and exported",
  { tags: ["export"] },
  async ({ app, screen }) => {
    await openReadyJobs(app, screen);
    await screen
      .getByRole("checkbox", "Selecteer Senior Data Engineer")
      .check();
    await screen.getByRole("button", /Snapshot maken/u).tap();
    await expect(
      screen.getByRole("status").filter({
        hasText: "Snapshot aangemaakt (1 geselecteerde opdrachten).",
      })
    ).toBeVisible();
    await screen.getByRole("link", "Bekijk snapshot").tap();
    await expect(
      screen.getByRole("heading", "Snapshot", { level: 1 })
    ).toBeVisible();
    await screen.getByLabel("Motivatie").fill("E2E fixture approval");
    await screen.getByRole("button", "Keur snapshot goed").tap();
    await expect(
      screen.getByRole("status").filter({ hasText: "Goedkeuring vastgelegd." })
    ).toBeVisible();
    await screen.getByRole("button", "Exporteren naar Spott").tap();
    await expect(
      screen.getByRole("status").filter({
        hasText: "Export vastgelegd: 1 aangemaakt, 0 mislukt, 0 overgeslagen.",
      })
    ).toBeVisible();
  }
);

test(
  "the exports list renders all seeded snapshot statuses",
  { tags: ["export"] },
  async ({ app, screen }) => {
    await app.open("/exports");
    await expect(
      screen.getByRole("heading", "Exports", { level: 1 })
    ).toBeVisible();
    await expect(screen.getByText("In afwachting")).toBeVisible();
    await expect(screen.getByText("Goedgekeurd")).toBeVisible();
    await expect(screen.getByText("Geëxporteerd")).toBeVisible();
  }
);
