import path from "node:path";

import { expect, test as setup } from "@playwright/test";

const authFile = path.resolve(
  import.meta.dirname,
  "../../.artifacts/e2e/field-gap-auth.json"
);

setup("authenticate", async ({ page }) => {
  const email = process.env.CTP514_E2E_EMAIL;
  const password = process.env.CTP514_E2E_PASSWORD;
  if (!(email && password)) {
    throw new Error(
      "CTP514_E2E_EMAIL and CTP514_E2E_PASSWORD are required; source the operator login file"
    );
  }

  await page.goto("/login", { waitUntil: "domcontentloaded" });
  await expect(
    page.getByRole("heading", { name: "Welcome Back" })
  ).toBeVisible();
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign In" }).click();
  await page.waitForURL("**/dashboard", { timeout: 30_000 });
  await page.context().storageState({ path: authFile });
});
