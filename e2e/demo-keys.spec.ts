import { expect, test, type Page } from "@playwright/test";
import { OWNER, signInWithPassword, watchErrors } from "./helpers";

/**
 * Demo keys: Hasan adds a key on his account page; someone who isn't signed in types it under
 * "Have a demo key?" and is in his account, kept out of Account, Family and Health, until the tab
 * closes. Each key works once on each device.
 */
async function tryKey(p: Page, word: string) {
  await p.goto("/sign-in");
  await p.getByRole("button", { name: "Have a demo key?" }).click();
  const form = p.getByTestId("demo-key-form");
  await form.getByLabel("Demo key").fill(word);
  await form.getByRole("button", { name: "Open the demo" }).click();
}
const REFUSED = "That demo key isn't right, or it was already used.";

test("a demo key opens the owner's account once per device, until the tab closes", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const word = `demo ${Math.random().toString(36).slice(2, 10)}`;

  await signInWithPassword(page, OWNER.email, OWNER.password);
  await expect(page.getByRole("heading", { name: `Hi, ${OWNER.name}.` })).toBeVisible({ timeout: 20_000 });
  await page.goto("/account");
  await expect(page.locator("form[data-ready]").first()).toBeAttached();
  const add = page.getByTestId("add-demo-key");
  await add.getByLabel("New demo key").fill(word);
  await add.getByRole("button", { name: "Add demo key" }).click();
  await expect(add.getByText("Added.")).toBeVisible({ timeout: 15_000 });

  const device = await browser.newContext();
  const v = await device.newPage();
  await tryKey(v, "not the key");
  await expect(v.getByText(REFUSED)).toBeVisible({ timeout: 15_000 });
  await tryKey(v, `  ${word.toUpperCase()} `);
  await expect(v.getByRole("heading", { name: `Hi, ${OWNER.name}.` })).toBeVisible({ timeout: 20_000 });
  const notice = v.getByTestId("demo-notice");
  await expect(notice).toContainText("when you close this tab you won't be able to sign in again unless you have another demo key");
  await expect(notice).not.toContainText(/two|device/i);

  // The family's keys and members, the account and Health stay closed. Reloading keeps the demo.
  for (const path of ["/account", "/family", "/health"]) {
    await v.goto(path);
    await expect(v).toHaveURL(/\/$/);
  }
  expect((await v.request.post("/family", { data: "x", maxRedirects: 0 })).status()).toBe(403);
  await v.reload();
  await expect(v.getByRole("heading", { name: `Hi, ${OWNER.name}.` })).toBeVisible();
  await notice.getByRole("button", { name: "OK" }).click();
  await expect(notice).toBeHidden();

  // A new tab (as after closing the demo tab) signs out, and the key doesn't work again here.
  const again = await device.newPage();
  await again.goto("/");
  await expect(again).toHaveURL(/\/sign-in/, { timeout: 15_000 });
  await v.close();
  await tryKey(again, word);
  await expect(again.getByText(REFUSED)).toBeVisible({ timeout: 15_000 });
  await device.close();

  // Another device can still use it once.
  const other = await browser.newContext();
  const o = await other.newPage();
  await tryKey(o, word);
  await expect(o.getByRole("heading", { name: `Hi, ${OWNER.name}.` })).toBeVisible({ timeout: 20_000 });
  await other.close();

  // The owner's own session is untouched.
  await page.goto("/account");
  await expect(page.getByTestId("demo-keys")).toContainText(/Key \d+: first used/);
  await expect(page.getByTestId("demo-notice")).toHaveCount(0);
  expect(errors).toEqual([]);
});
