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
  await expect(
    screen.getByRole("heading", "Log in om opdrachten te bekijken", {
      level: 1,
    })
  ).toBeVisible();
  await expect(
    screen.getByRole("main").getByRole("button", "Inloggen")
  ).toBeVisible();
});
