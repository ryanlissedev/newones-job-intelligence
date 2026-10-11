import { test as base } from "@e2e-dev/web";

/** Forward browser auth requests through the runner so remote Chromium lanes
 * can reach the local stub even when their loopback namespace differs. */
export const test = base.extend<{ fixtureAuthProxy: true }>({
  fixtureAuthProxy: async ({ browser }, use) => {
    await browser.route("**/api/auth/**", async (route) => {
      const response = await fetch(route.request.url, {
        body: route.request.postData,
        headers: route.request.headers,
        method: route.request.method,
      });
      const headers = Object.fromEntries(response.headers.entries());
      delete headers["content-encoding"];
      delete headers["content-length"];
      await route.fulfill({
        body: await response.text(),
        headers,
        status: response.status,
      });
    });
    await use(true);
  },
});
