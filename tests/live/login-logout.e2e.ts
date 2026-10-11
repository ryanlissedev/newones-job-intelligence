import { test } from "@e2e-dev/web";
import { credentials, expect } from "e2e";

const liveUsername = process.env.E2E_USER_LIVE_USERNAME;
const livePassword = process.env.E2E_USER_LIVE_PASSWORD;
const canWriteSession =
  liveUsername !== undefined &&
  liveUsername !== "" &&
  livePassword !== undefined &&
  livePassword !== "" &&
  process.env.E2E_LIVE_ALLOW_SESSION_WRITES === "1";
const skipReason = canWriteSession
  ? false
  : "Set E2E_USER_LIVE_USERNAME, E2E_USER_LIVE_PASSWORD, and E2E_LIVE_ALLOW_SESSION_WRITES=1 to permit live session writes";

test(
  "live credentials can sign in and sign out when explicitly enabled",
  { skip: skipReason, tags: ["session"] },
  async ({ app, browser, screen }) => {
    const live = credentials.user("live");
    await app.open("/login");
    await screen.getByLabel("Email").fill(live.username);
    await screen.getByLabel("Password").fill(live.password);
    await screen.getByRole("button", "Sign In").tap();
    const banner = screen.getByRole("banner");
    try {
      await expect(browser).toHaveURL(/\/dashboard$/u);
      await expect(banner.getByRole("button", "Inloggen")).toBeHidden();
      // The user menu trigger is labelled with the account's display name,
      // which the test does not know; it is the last header button, after
      // "Thema wijzigen".
      await banner.getByRole("button").last().tap();
      await screen.getByRole("menuitem", "Uitloggen").tap();
      await expect(banner.getByRole("button", "Inloggen")).toBeVisible();
    } finally {
      try {
        const loginButton = banner.getByRole("button", "Inloggen");
        if (!(await loginButton.isVisible())) {
          await banner.getByRole("button").last().tap();
          await screen.getByRole("menuitem", "Uitloggen").tap();
        }
      } catch {
        // Cleanup is best effort; preserve the original test failure.
      }
    }
  }
);
