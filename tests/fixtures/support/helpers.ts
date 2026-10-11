import type { Browser } from "@e2e-dev/web";
import type { App, Screen } from "e2e";

const expectVisible = async (screen: Screen): Promise<void> => {
  await screen.getByRole("heading", "Opdrachten", { level: 1 }).waitFor();
  await screen.getByText(/\d+ resultaten?/u).waitFor();
};

export const openReadyJobs = async (
  app: App,
  screen: Screen
): Promise<void> => {
  await app.open("/jobs");
  await expectVisible(screen);
};

export const setFixtureSession = async (
  browser: Browser,
  _baseUrl: string
): Promise<void> => {
  await browser.setCookies([
    {
      name: "better-auth.session_token",
      url: `http://127.0.0.1:${process.env.E2E_FIXTURES_AUTH_PORT ?? "3310"}/`,
      value: "e2e-valid.fixture",
    },
  ]);
};
