import { beforeEach } from "@e2e-dev/web";
import { expect } from "e2e";

import {
  captureVisual,
  FIXTURE_VISUAL_INSTANT,
  freezeClock,
  visualMode,
} from "../support/visual";
import { test } from "./support/test";

const visualOptions = {
  skip: visualMode() === "off" ? "E2E_VISUAL=off" : false,
  tags: ["visual"],
} as const;

beforeEach(async ({ app, browser }) => {
  if (!app.baseUrl) {
    throw new Error("Fixture app base URL is unavailable");
  }
  await freezeClock(browser, app.baseUrl, FIXTURE_VISUAL_INSTANT);
});

test("login page", visualOptions, async ({ app, screen, browser }) => {
  await app.open("/login");
  await expect(
    screen.getByRole("heading", "Welcome Back", { level: 1 })
  ).toBeVisible();
  await expect(screen.getByRole("button", "Sign In")).toBeVisible();
  // Proves the document-level injection from freezeClock (beforeEach), not
  // the post-load re-apply inside captureVisual.
  const frozenNow = await browser.evaluate(() => Date.now());
  const frozenBase = Date.parse(FIXTURE_VISUAL_INSTANT);
  expect(frozenNow).toBeGreaterThanOrEqual(frozenBase);
  expect(frozenNow).toBeLessThan(frozenBase + 10_000);
  await captureVisual({ app, browser }, "login");
});

test("public home", visualOptions, async ({ app, screen, browser }) => {
  await app.open("/");
  await expect(
    screen.getByRole("heading", "Vind de juiste opdracht vóór de rest.", {
      level: 1,
    })
  ).toBeVisible();
  await captureVisual({ app, browser }, "home-public");
});

test(
  "authenticated home overview",
  visualOptions,
  async ({ app, browser, screen }) => {
    await browser.setCookies([
      {
        name: "better-auth.session_token",
        url: `http://127.0.0.1:${process.env.E2E_FIXTURES_AUTH_PORT ?? "3310"}/`,
        value: "e2e-valid.fixture",
      },
    ]);
    await app.open("/");
    await expect(screen.getByText("Demogegevens")).toBeVisible();
    await expect(
      screen.getByRole("heading", "Vind de juiste opdracht vóór de rest.", {
        level: 1,
      })
    ).toBeVisible();
    await captureVisual({ app, browser }, "home-overview");
  }
);

test("opdrachten list", visualOptions, async ({ app, browser, screen }) => {
  await app.open("/jobs");
  await expect(screen.getByText("20 resultaten")).toBeVisible();
  await expect(
    screen.getByRole("button", "Senior Data Engineer")
  ).toBeVisible();
  await captureVisual({ app, browser }, "opdrachten-list");
});

test("search results", visualOptions, async ({ app, browser, screen }) => {
  await app.open("/jobs?q=Azure");
  await expect(
    screen.getByRole("button", "Senior Data Engineer")
  ).toBeVisible();
  await expect(screen.getByText("2 resultaten")).toBeVisible();
  await captureVisual({ app, browser }, "search-results");
});

test("job detail", visualOptions, async ({ app, browser, screen }) => {
  await app.open("/jobs?job=job-001");
  await expect(
    screen.getByRole("heading", "Senior Data Engineer", { level: 2 })
  ).toBeVisible();
  await expect(
    screen.getByRole("heading", "Herkomst", { level: 3 })
  ).toBeVisible();
  await captureVisual({ app, browser }, "detail");
});

test("exports list", visualOptions, async ({ app, browser, screen }) => {
  await app.open("/exports");
  await expect(
    screen.getByRole("heading", "Exports", { level: 1 })
  ).toBeVisible();
  await expect(screen.getByText("In afwachting")).toBeVisible();
  await expect(screen.getByText("Goedgekeurd")).toBeVisible();
  await expect(screen.getByText("Geëxporteerd")).toBeVisible();
  await captureVisual({ app, browser }, "exports");
});

test("dashboard", visualOptions, async ({ app, browser, screen }) => {
  await browser.setCookies([
    {
      name: "better-auth.session_token",
      url: `http://127.0.0.1:${process.env.E2E_FIXTURES_AUTH_PORT ?? "3310"}/`,
      value: "e2e-valid.fixture",
    },
  ]);
  await app.open("/dashboard");
  await expect(
    screen.getByRole("heading", "Dashboard", { level: 1 })
  ).toBeVisible();
  await expect(
    screen.getByRole("heading", "Vind de juiste opdracht vóór de rest.", {
      level: 2,
    })
  ).toBeVisible();
  await captureVisual({ app, browser }, "dashboard", {
    mask: [
      "#main-content > div:nth-child(2)",
      "#main-content > div:nth-child(3)",
    ],
  });
});

test("snapshot detail", visualOptions, async ({ app, browser, screen }) => {
  await app.open("/jobs");
  await expect(screen.getByText("20 resultaten")).toBeVisible();
  await screen.getByRole("checkbox", "Selecteer Senior Data Engineer").check();
  await screen.getByRole("button", /Snapshot maken/u).tap();
  await screen.getByRole("link", "Bekijk snapshot").tap();
  await expect(
    screen.getByRole("heading", "Snapshot", { level: 1 })
  ).toBeVisible();
  await expect(screen.getByText("Goedkeuring")).toBeVisible();
  await captureVisual({ app, browser }, "snapshot", {
    // Snapshot uuid, the meta card (timestamps, digests) and "Geldig tot"
    // are per-run values; the approval/export cards stay visible.
    mask: [
      "#main-content > div:first-child p.font-mono:not(.uppercase)",
      "#main-content > div:nth-child(2)",
      "#snapshot-expires-at",
    ],
  });
});
