import { test } from "@e2e-dev/web";
import { expect } from "e2e";

test("the public shell shows job intelligence navigation", async ({
  app,
  screen,
}) => {
  await app.open("/login");
  await expect(screen.getByRole("link", "Newones — overzicht")).toBeVisible();
  await expect(screen.getByRole("navigation", "Hoofdnavigatie")).toBeVisible();
  await expect(screen.getByRole("link", "Overzicht")).toBeVisible();
});
