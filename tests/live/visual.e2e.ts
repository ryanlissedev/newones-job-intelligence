import { beforeEach, test } from "@e2e-dev/web";
import { expect } from "e2e";

import { captureVisual, freezeClock, visualMode } from "../support/visual";

const skip = visualMode() === "off" ? "E2E_VISUAL=off" : false;
const visualOptions = { skip, tags: ["visual"] } as const;

beforeEach(async ({ app, browser }) => {
  if (!app.baseUrl) {
    throw new Error("Live app base URL is unavailable");
  }
  await freezeClock(browser, app.baseUrl, "2026-09-01T09:00:00+02:00");
});

test("live login", visualOptions, async ({ app, browser, screen }) => {
  await app.open("/login");
  await expect(
    screen.getByRole("heading", "Welcome Back", { level: 1 })
  ).toBeVisible();
  await captureVisual({ app, browser }, "login");
});

test("live home hero", visualOptions, async ({ app, browser, screen }) => {
  await app.open("/");
  await expect(
    screen.getByRole("heading", "Vind de juiste opdracht vóór de rest.", {
      level: 1,
    })
  ).toBeVisible();
  await expect(
    screen.getByRole("banner").getByRole("button", "Inloggen")
  ).toBeVisible();
  await captureVisual({ app, browser }, "home");
});

test(
  "live jobs login wall",
  visualOptions,
  async ({ app, browser, screen }) => {
    await app.open("/jobs");
    await expect(
      screen.getByRole("heading", "Log in om opdrachten te bekijken", {
        level: 2,
      })
    ).toBeVisible();
    await captureVisual({ app, browser }, "jobs");
  }
);

test(
  "live bronnen access guard",
  visualOptions,
  async ({ app, browser, screen }) => {
    await app.open("/bronnen");
    await expect(
      screen.getByText("Je hebt geen toegang tot de bronmonitor.")
    ).toBeVisible();
    await captureVisual({ app, browser }, "bronnen");
  }
);
