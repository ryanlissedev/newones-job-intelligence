import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

const VERIFY_EMAIL = "marktvragen-verify@example.invalid";
const VERIFY_PASSWORD = "Marktvragen-pass-8!";
const SERVER_URL = process.env.NEXT_PUBLIC_SERVER_URL ?? "http://localhost:3000";

const signIn = async (page: Page) => {
  const response = await page.request.post(
    `${SERVER_URL}/api/auth/sign-in/email`,
    {
      data: { email: VERIFY_EMAIL, password: VERIFY_PASSWORD },
      headers: {
        "Content-Type": "application/json",
        Origin: "http://localhost:3001",
      },
    }
  );
  expect(response.ok()).toBeTruthy();
  await page.goto("/chat", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Assistent" })).toBeVisible({
    timeout: 20_000,
  });
};

test.describe("Assistent chat", () => {
  test("chat-redirect: /chat stuurt niet-ingelogden naar /login", async ({
    page,
  }) => {
    await page.goto("/chat", { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(/\/login/u);
    await expect(
      page.getByRole("heading", { name: "Welcome Back" })
    ).toBeVisible();
  });

  test("chat-page: ingelogde /chat toont chat-first shell (thread + Ask… + chips)", async ({
    page,
  }) => {
    await signIn(page);
    await expect(page.getByText("Vraag de assistent")).toBeVisible();
    await expect(page.getByLabel("Vraag aan de assistent")).toBeVisible();
    await expect(page.getByPlaceholder("Ask…")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Zoek open aanvragen in Amsterdam" })
    ).toBeVisible();
    await expect(page.getByText("Wat kan de assistent?")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Verstuur vraag" })
    ).toBeVisible();
    await page.screenshot({
      path: "shots/assistant-chat-page.png",
      fullPage: true,
    });
  });

  test("chat-nav: headerlink Assistent navigeert naar /chat", async ({
    page,
  }) => {
    await signIn(page);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.getByRole("link", { name: "Assistent" }).click();
    await expect(page).toHaveURL(/\/chat/u);
    await expect(page.getByRole("heading", { name: "Assistent" })).toBeVisible();
  });
});
