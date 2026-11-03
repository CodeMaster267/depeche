import { expect, test } from "@playwright/test";
import { noSidewaysScroll, watchErrors } from "./helpers";

for (const scheme of ["light", "dark"] as const) {
  test.describe(`sign-in title card, ${scheme} mode`, () => {
    test.use({ colorScheme: scheme });

    test("shows the wordmark and all three ways in, with no errors and no sideways scroll", async ({ page }) => {
      const errors = watchErrors(page);
      await page.goto("/");
      await expect(page).toHaveURL(/\/sign-in$/);
      await expect(page.getByRole("img", { name: "Depeche" })).toBeVisible();
      await expect(page.getByText("Invite only. Sign in to continue.")).toBeVisible();
      await expect(page.getByLabel("Email address")).toBeVisible();
      await expect(page.getByRole("button", { name: "Send me a sign-in link" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Continue with Google" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Use a username and password" })).toBeVisible();
      await noSidewaysScroll(page);

      const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      expect(bg).toBe(scheme === "dark" ? "rgb(0, 0, 0)" : "rgb(255, 255, 255)");
      expect(errors).toEqual([]);
    });
  });
}

test("glitch is switched off for people who ask for reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/sign-in");
  for (const part of [".slice", ".shard", ".streak-line"]) {
    const all = page.locator(`.glitch ${part}`);
    expect(await all.count()).toBeGreaterThan(0);
    for (const el of await all.all()) await expect(el).toBeHidden();
  }
});
