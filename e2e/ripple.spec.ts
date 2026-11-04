import { expect, test, type Page } from "@playwright/test";
import { OWNER, noSidewaysScroll, signInWithPassword, watchErrors } from "./helpers";

/** Desktop projects have a real mouse; phones and tablets are touch screens, where the field drifts on its own. */
const isDesktop = (page: Page) => (page.viewportSize()?.width ?? 0) >= 900;

/** On a touch screen the field drifts by itself, without anyone touching it. */
async function expectDrifting(page: Page, first = true) {
  const field = page.getByTestId("ripple");
  await expect(field).toHaveCount(1);
  await expect(field).toHaveAttribute("data-mode", "ambient");
  await expect(field).toHaveAttribute("aria-hidden", "true");
  expect(await field.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe("none");
  if (await canRun(page)) {
    // It starts drifting. Where the browser can't keep up (CI has no GPU), it settles into a still
    // field rather than slowing the page down.
    // (Once a page found it too slow, later pages in the same visit start still.)
    if (first) await expect(field).toHaveAttribute("data-drifted", "1");
    await expect(field).toHaveAttribute("data-ripple", /^(drifting|still)$/);
  }
}

/** The field needs WebGL2 with renderable half-float textures; without it the page stays plain. */
async function canRun(page: Page) {
  return page.evaluate(() => {
    const gl = document.createElement("canvas").getContext("webgl2");
    return !!gl && !!(gl.getExtension("EXT_color_buffer_float") || gl.getExtension("EXT_color_buffer_half_float"));
  });
}

/** Sweeps the mouse across the left side of the screen, like someone reaching for the form. */
async function sweep(page: Page) {
  const box = (await page.getByTestId("ripple").boundingBox())!;
  const x = box.x + 40, y = box.y + Math.min(box.height - 40, 600);
  await page.mouse.move(x, y);
  for (let i = 0; i <= 30; i++) {
    await page.mouse.move(x + i * 10, y - i * 12);
    await page.waitForTimeout(16);
  }
}

test("sign-in: the letterflip field ripples under a mouse on desktop and drifts on its own on touch screens", async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto("/sign-in");
  const field = page.getByTestId("ripple");
  if (!isDesktop(page)) {
    await expectDrifting(page);
    // Taps still reach the form through it.
    await page.getByRole("button", { name: "Use a username and password" }).click();
    await expect(page.getByLabel("Password")).toBeVisible();
    await noSidewaysScroll(page);
    expect(errors).toEqual([]);
    return;
  }
  await expect(field).toHaveCount(1);
  await expect(field).toHaveAttribute("data-mode", "mouse");
  // Decoration only: hidden from screen readers and never in the way of a click.
  await expect(field).toHaveAttribute("aria-hidden", "true");
  expect(await field.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe("none");
  if (!(await canRun(page))) {
    await expect(field).not.toHaveAttribute("data-ripple", /./);
    expect(errors).toEqual([]);
    return;
  }
  await expect(field).toHaveAttribute("data-ripple", "ready");
  await sweep(page);
  await expect(field).toHaveAttribute("data-ripple", "moving");
  // It stops itself once the ripple has faded, so an idle page costs nothing.
  await expect(field).toHaveAttribute("data-ripple", "ready", { timeout: 15_000 });
  // The form still works through it.
  await page.getByRole("button", { name: "Use a username and password" }).click();
  await expect(page.getByLabel("Password")).toBeVisible();
  await noSidewaysScroll(page);
  expect(errors).toEqual([]);
});

test("sign-in: no field for people who asked for less motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/sign-in");
  await expect(page.getByRole("button", { name: "Send me a sign-in link" })).toBeVisible();
  await expect(page.getByTestId("ripple")).toHaveCount(0);
});

test("new chat: the field sits behind an empty chat, clear of the greeting", async ({ page }) => {
  const errors = watchErrors(page);
  await signInWithPassword(page, OWNER.email, OWNER.password);
  const hi = page.getByRole("heading", { name: `Hi, ${OWNER.name}.` });
  await expect(hi).toBeVisible();
  const field = page.getByTestId("ripple");
  if (isDesktop(page)) await expect(field).toHaveAttribute("data-mode", "mouse");
  else await expectDrifting(page, false);
  // The field stays inside the conversation area: the composer and header sit outside it.
  const box = (await field.boundingBox())!;
  const composer = (await page.locator("textarea").last().boundingBox())!;
  expect(box.y + box.height).toBeLessThanOrEqual(composer.y + 1);
  if (isDesktop(page) && (await canRun(page))) {
    await expect(field).toHaveAttribute("data-ripple", "ready");
    await sweep(page);
    await expect(field).toHaveAttribute("data-ripple", "moving");
    await page.screenshot({ path: test.info().outputPath("new-chat-ripple.png") });
  }
  // The greeting stays on top of the field.
  const top = await hi.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return document.elementFromPoint(r.left + 10, r.top + r.height / 2)?.closest("h2") === el;
  });
  expect(top).toBe(true);
  expect(errors).toEqual([]);
});
