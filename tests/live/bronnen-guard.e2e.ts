import { expect, test } from "e2e";

test("the source monitor turns an anonymous visitor away", async ({
  app,
  screen,
}) => {
  await app.open("/bronnen");
  await expect(
    screen.getByText("Je hebt geen toegang tot de bronmonitor.")
  ).toBeVisible();
  await expect(
    screen.getByRole("heading", "Vind de juiste opdracht vóór de rest.", {
      level: 1,
    })
  ).toBeVisible();
});
