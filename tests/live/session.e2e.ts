import { test } from "@e2e-dev/web";
import { expect } from "e2e";

test(
  "expired session cookies remain anonymous on jobs and home",
  { tags: ["session"] },
  async ({ app, browser, screen }) => {
    if (!app.baseUrl) {
      throw new Error("Live app base URL is unavailable");
    }
    // The session cookie may live on the web origin or, when the API runs on
    // its own host, on the API origin (E2E_LIVE_API_URL, optional).
    const origins = [app.baseUrl, process.env.E2E_LIVE_API_URL]
      .filter((value): value is string => value !== undefined && value !== "")
      .map((value) => new URL(value).origin);
    const expiredCookies: {
      readonly name: string;
      readonly secure?: boolean;
      readonly url: string;
      readonly value: string;
    }[] = [];
    for (const origin of origins) {
      expiredCookies.push({
        name: "better-auth.session_token",
        url: `${origin}/`,
        value: "e2e-expired",
      });
      if (origin.startsWith("https://")) {
        expiredCookies.push({
          name: "__Secure-better-auth.session_token",
          secure: true,
          url: `${origin}/`,
          value: "e2e-expired",
        });
      }
    }
    await browser.setCookies(expiredCookies);

    await app.open("/jobs");
    await expect(
      screen.getByRole("heading", "Log in om opdrachten te bekijken", {
        level: 2,
      })
    ).toBeVisible();
    await app.open("/");
    await expect(
      screen.getByRole("heading", "Vind de juiste opdracht vóór de rest.", {
        level: 1,
      })
    ).toBeVisible();
    await expect(
      screen.getByRole("banner").getByRole("button", "Inloggen")
    ).toBeVisible();
  }
);
