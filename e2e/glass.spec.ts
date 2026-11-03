import { expect, test } from "@playwright/test";
import { OWNER, noSidewaysScroll, signInWithPassword, watchErrors } from "./helpers";

test("main buttons are glass pills with bent code inside, kept clear behind the label", async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto("/sign-in");
  const button = page.locator("button.glass-pill").first();
  await expect(button).toBeVisible();
  const code = button.locator(".glass-code");
  // The bend filter is built for the button's size once it's on screen.
  await expect.poll(() => code.evaluate((el) => getComputedStyle(el).filter)).toMatch(/url\("?#glass-bend-\d+x\d+"?\)/);
  const id = (await code.evaluate((el) => getComputedStyle(el).filter)).match(/glass-bend-\d+x\d+/)![0];
  expect(await page.locator(`filter#${id} feDisplacementMap`).count()).toBe(3);
  // The code is decorative: hidden from screen readers, never in the button's name.
  await expect(button.locator(".glass-lens")).toHaveAttribute("aria-hidden", "true");
  await expect(button).not.toHaveAccessibleName(/0x|send\(\)/);
  await expect(button).toHaveAccessibleName(/\w/);
  // The clear patch is sized to the label.
  expect(await button.locator(".glass-lens").evaluate((el) => el.style.getPropertyValue("--clear"))).toMatch(/^\d+px$/);
  await noSidewaysScroll(page);
  expect(errors).toEqual([]);
});

test("the tap flash waits on touch and a swipe cancels it", async ({ page }) => {
  await page.goto("/sign-in");
  const button = page.locator("button.glass-pill").first();
  const result = await button.evaluate(async (el) => {
    const r = el.getBoundingClientRect();
    const at = (type: string, dx = 0) =>
      el.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerType: "touch", clientX: r.left + 20 + dx, clientY: r.top + 10 }));
    const wait = (ms: number) => new Promise((res) => setTimeout(res, ms));
    at("pointerdown");
    const immediately = el.hasAttribute("data-pressed");
    await wait(150);
    const held = el.hasAttribute("data-pressed");
    el.removeAttribute("data-pressed");
    at("pointerdown");
    at("pointermove", 30);
    await wait(150);
    const swiped = el.hasAttribute("data-pressed");
    at("pointerup", 30);
    const afterSwipe = el.hasAttribute("data-pressed");
    at("pointerdown");
    at("pointerup");
    const quickTap = el.hasAttribute("data-pressed");
    return { immediately, held, swiped, afterSwipe, quickTap };
  });
  expect(result).toEqual({ immediately: false, held: true, swiped: false, afterSwipe: false, quickTap: true });
});

test("New chat is a glass pill and Send is plain smoky glass", async ({ page }) => {
  const errors = watchErrors(page);
  await signInWithPassword(page, OWNER.email, OWNER.password);
  await page.getByRole("heading", { name: "Hi, Hasan." }).waitFor();
  // With an empty box the round button starts voice chat (when the family has a key that can listen).
  const round = page.getByRole("button", { name: /^(Send|Voice chat)$/ });
  await expect(round).toHaveClass(/\bglass\b/);
  await expect(round.locator(".glass-code")).toHaveCount(0);
  const isPhone = (page.viewportSize()?.width ?? 1000) < 768;
  if (isPhone) await page.getByRole("button", { name: "Open menu" }).click();
  const newChat = page.getByRole("link", { name: "New chat" }).filter({ has: page.locator(".glass-code"), visible: true });
  await expect(newChat).toBeVisible();
  await expect(newChat).toHaveClass(/glass-pill/);
  expect(errors).toEqual([]);
});
