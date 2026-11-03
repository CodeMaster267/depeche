import { expect, test } from "@playwright/test";
import { OWNER, signInWithPassword, watchErrors } from "./helpers";

test("buttons flash the moment they are pressed", async ({ page }) => {
  await page.goto("/sign-in");
  const button = page.getByRole("button", { name: "Continue with Google" });
  await expect(button).toHaveClass(/\bpress\b/);
  // The flash starts on pointerdown, before any navigation or server reply.
  const flashed = await button.evaluate((el) => {
    el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    return el.hasAttribute("data-pressed") && getComputedStyle(el).animationName;
  });
  expect(flashed).toBe("press-glitch");
});

test("reduced motion gets a plain dip instead of the glitch flash", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/sign-in");
  const name = await page.getByRole("button", { name: "Continue with Google" }).evaluate((el) => {
    el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    return getComputedStyle(el).animationName;
  });
  expect(name).toBe("press-dip");
});

test("header links look like buttons and mark the current page", async ({ page }) => {
  const errors = watchErrors(page);
  await signInWithPassword(page, OWNER.email, OWNER.password);
  const account = page.getByRole("link", { name: "Account" });
  await expect(account).toHaveClass(/nav-pill/);
  const border = await account.evaluate((el) => getComputedStyle(el).borderTopWidth);
  expect(border).toBe("1px");
  await account.click();
  await expect(page).toHaveURL(/\/account$/);
  await expect(page.getByRole("link", { name: "Account" })).toHaveAttribute("aria-current", "page");
  // Sign out sits at the top now, beside the email.
  await expect(page.getByRole("button", { name: "Sign out" })).toBeInViewport();
  expect(errors).toEqual([]);
});

test("a glitching wordmark shows while the next page loads", async ({ page }) => {
  await signInWithPassword(page, OWNER.email, OWNER.password);
  const family = page.getByRole("link", { name: "Family" });
  await family.waitFor();
  await page.waitForTimeout(1000); // let the link prefetch finish
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route("**/family**", async (route) => {
    if (!route.request().headers()["next-router-prefetch"]) await held;
    await route.continue().catch(() => {});
  });
  await family.click();
  await expect(page.locator(".loader .glitch")).toBeVisible();
  release();
  await expect(page).toHaveURL(/\/family$/);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.locator(".loader")).toHaveCount(0);
});

test("the D icon is the favicon, the iPhone home-screen icon and the app icon", async ({ page, request }) => {
  await page.goto("/sign-in");
  for (const rel of ["icon", "apple-touch-icon"]) {
    const href = await page.locator(`link[rel="${rel}"]`).first().getAttribute("href");
    expect((await request.get(href!)).status()).toBe(200);
  }
  const manifest = await (await request.get("/manifest.webmanifest")).json();
  expect(manifest.display).toBe("standalone");
  for (const icon of manifest.icons) expect((await request.get(icon.src)).status()).toBe(200);
});
