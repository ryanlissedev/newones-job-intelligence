import { credentials, expect } from "e2e";

import { test } from "./support/test";

const fixture = credentials.user("fixture");

test(
  "the fixture user can sign in and sign out",
  { tags: ["session"] },
  async ({ app, browser, screen }) => {
    await app.open("/login");
    await screen.getByLabel("Email").fill(fixture.username);
    await screen.getByLabel("Password").fill(fixture.password);
    await screen.getByLabel("Password").press("Enter");
    await expect(browser).toHaveURL(/\/dashboard$/u);
    await expect(
      screen.getByRole("heading", "Dashboard", { level: 1 })
    ).toBeVisible();
    await expect(screen.getByText("Welcome E2E Tester")).toBeVisible();
    await expect(screen.getByRole("button", "E2E Tester")).toBeVisible();

    await screen.getByRole("button", "E2E Tester").tap();
    await screen.getByRole("menuitem", "Uitloggen").tap();
    await expect(
      screen.getByRole("banner").getByRole("button", "Inloggen")
    ).toBeVisible();
    const cookies = await browser.cookies();
    await expect(
      cookies.find((cookie) => cookie.name === "better-auth.session_token")
    ).toBeUndefined();
  }
);

test(
  "a wrong fixture password stays on login and shows the auth error",
  { tags: ["session"] },
  async ({ app, browser, screen }) => {
    await app.open("/login");
    await screen.getByLabel("Email").fill(fixture.username);
    await screen.getByLabel("Password").fill("not-the-fixture-password");
    await screen.getByRole("button", "Sign In").tap();
    await expect(screen.getByText("Invalid email or password")).toBeVisible();
    await expect(browser).toHaveURL(/\/login$/u);
  }
);

test(
  "the sign-in form shows validation for invalid empty values",
  { tags: ["session"] },
  async ({ app, screen }) => {
    await app.open("/login");
    await screen.getByLabel("Email").fill("");
    await screen.getByLabel("Password").fill("");
    await screen.getByRole("button", "Sign In").tap();
    await expect(screen.getByText("Invalid email address")).toBeVisible();
    await expect(
      screen.getByText("Password must be at least 8 characters")
    ).toBeVisible();
  }
);

test(
  "an expired fixture session is redirected to the anonymous login wall",
  { tags: ["session"] },
  async ({ app, browser, screen }) => {
    if (!app.baseUrl) {
      throw new Error("Fixture app base URL is unavailable");
    }
    await browser.setCookies([
      {
        name: "better-auth.session_token",
        url: `http://127.0.0.1:${process.env.E2E_FIXTURES_AUTH_PORT ?? "3310"}/`,
        value: "e2e-expired",
      },
    ]);
    await app.open("/dashboard");
    await expect(browser).toHaveURL(/\/login$/u);
    await expect(
      screen.getByRole("banner").getByRole("button", "Inloggen")
    ).toBeVisible();
  }
);
