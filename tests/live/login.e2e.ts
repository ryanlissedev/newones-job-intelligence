import { expect, test } from "e2e";

test("the login page shows the sign-in form to an anonymous visitor", async ({
  app,
  screen,
}) => {
  await app.open("/login");
  await expect(
    screen.getByRole("heading", "Welcome Back", { level: 1 })
  ).toBeVisible();
  await expect(screen.getByRole("textbox", "Email")).toBeVisible();
  await expect(screen.getByRole("button", "Sign In")).toBeVisible();
});
