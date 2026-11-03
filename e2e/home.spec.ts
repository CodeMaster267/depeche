import { expect, test } from "@playwright/test";

for (const scheme of ["light", "dark"] as const) {
  test.describe(`title card, ${scheme} mode`, () => {
    test.use({ colorScheme: scheme });

    test("shows the wordmark with no errors and no sideways scroll", async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

      await page.goto("/");
      await expect(page.getByRole("img", { name: "Depeche" })).toBeVisible();
      await expect(page.getByText("Invite only.")).toBeVisible();

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, "page scrolls sideways").toBeLessThanOrEqual(0);

      const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      expect(bg).toBe(scheme === "dark" ? "rgb(0, 0, 0)" : "rgb(255, 255, 255)");

      expect(errors).toEqual([]);
    });
  });
}

test("glitch is switched off for people who ask for reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect(page.locator(".glitch .s1")).toBeHidden();
  await expect(page.locator(".glitch .s2")).toBeHidden();
});
