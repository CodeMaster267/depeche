import { expect, test, type Page } from "@playwright/test";
import { OWNER, noSidewaysScroll, signInWithPassword, watchErrors } from "./helpers";

/** Desktop projects have a real mouse; phones are touch only and get no field at all. */
const isDesktop = (page: Page) => (page.viewportSize()?.width ?? 0) >= 900;

/** The field needs WebGL2 with renderable half-float textures; without it the page stays plain. */
async function canRun(page: Page) {
  return page.evaluate(() => {
    const gl = document.createElement("canvas").getContext("webgl2");
    return !!gl && !!(gl.getExtension("EXT_color_buffer_float") || gl.getExtension("EXT_color_buffer_half_float"));
  });
}

/** Sweeps the mouse across the left side of the screen, like someone reaching for the form. */
async function sweep(page: Page) {
  await page.mouse.move(120, 650);
  for (let i = 0; i <= 30; i++) {
    await page.mouse.move(120 + i * 10, 650 - i * 12);
    await page.waitForTimeout(16);
  }
}

test("sign-in: the letterflip field ripples under a mouse on desktop and rests afterwards", async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto("/sign-in");
  const field = page.getByTestId("ripple");
  if (!isDesktop(page)) {
    await expect(page.getByRole("button", { name: "Send me a sign-in link" })).toBeVisible();
    await expect(field).toHaveCount(0);
    expect(errors).toEqual([]);
    return;
  }
  await expect(field).toHaveCount(1);
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

test("new chat: the field sits behind an empty chat on desktop, clear of the greeting", async ({ page }) => {
  const errors = watchErrors(page);
  await signInWithPassword(page, OWNER.email, OWNER.password);
  const hi = page.getByRole("heading", { name: `Hi, ${OWNER.name}.` });
  await expect(hi).toBeVisible();
  const field = page.getByTestId("ripple");
  if (!isDesktop(page)) {
    await expect(field).toHaveCount(0);
    expect(errors).toEqual([]);
    return;
  }
  await expect(field).toHaveCount(1);
  // The field stays inside the conversation area: the composer and header sit outside it.
  const box = (await field.boundingBox())!;
  const composer = (await page.getByRole("textbox").first().boundingBox())!;
  expect(box.y + box.height).toBeLessThanOrEqual(composer.y + 1);
  if (await canRun(page)) {
    await expect(field).toHaveAttribute("data-ripple", "ready");
    await sweep(page);
    await expect(field).toHaveAttribute("data-ripple", "moving");
  }
  // The greeting stays on top of the field.
  const top = await hi.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return document.elementFromPoint(r.left + 10, r.top + r.height / 2)?.closest("h2") === el;
  });
  expect(top).toBe(true);
  expect(errors).toEqual([]);
});
