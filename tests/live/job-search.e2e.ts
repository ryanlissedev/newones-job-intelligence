import { expect, test } from "e2e";

test("job search from the navigation asks an anonymous visitor to sign in", async ({
  app,
  screen,
}) => {
  await app.open("/");
  await screen
    .getByRole("navigation", "Hoofdnavigatie")
    .getByRole("link", "Zoeken")
    .tap();
  // The page heading is server-rendered; the sign-in prompt follows once the
  // session check says there is no session.
  await expect(
    screen.getByRole("heading", "Opdrachten zoeken", { level: 1 })
  ).toBeVisible();
  await expect(
    screen.getByRole("heading", "Log in om opdrachten te bekijken", {
      level: 2,
    })
  ).toBeVisible();
  await expect(
    screen.getByRole("main").getByRole("button", "Inloggen")
  ).toBeVisible();
});
