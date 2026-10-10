import { expect, test } from "e2e";

test("the live home page shows the recruiter workspace and navigation", async ({
  app,
  screen,
}) => {
  await app.open("/");
  await expect(
    screen.getByRole("heading", "Vind de juiste opdracht vóór de rest.", {
      level: 1,
    })
  ).toBeVisible();
  const navigation = screen.getByRole("navigation", "Hoofdnavigatie");
  await expect(navigation.getByRole("link", "Overzicht")).toBeVisible();
  await expect(navigation.getByRole("link", "Zoeken")).toBeVisible();
});
