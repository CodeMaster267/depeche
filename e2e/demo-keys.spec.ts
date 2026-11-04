import { expect, test } from "@playwright/test";
import { OWNER, signInWithPassword, watchErrors } from "./helpers";

/**
 * Demo keys: Hasan adds a one-time key on his account page; someone who isn't signed in types it
 * under "Have a demo key?" and is in his account, but kept out of Account, Family and Health. The
 * key never works a second time.
 */
test("a demo key opens the owner's account once, in a limited demo", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const word = `demo ${Math.random().toString(36).slice(2, 10)}`;

  await signInWithPassword(page, OWNER.email, OWNER.password);
  await expect(page.getByRole("heading", { name: `Hi, ${OWNER.name}.` })).toBeVisible({ timeout: 20_000 });
  await page.goto("/account");
  await expect(page.locator("form[data-ready]").first()).toBeAttached();
  const add = page.getByTestId("add-demo-key");
  await add.getByLabel("New demo key").fill(word);
  await add.getByRole("button", { name: "Add demo key" }).click();
  await expect(add.getByText("Added. It works once.")).toBeVisible({ timeout: 15_000 });

  const visitor = await browser.newContext();
  const v = await visitor.newPage();
  await v.goto("/sign-in");
  await v.getByRole("button", { name: "Have a demo key?" }).click();
  const form = v.getByTestId("demo-key-form");
  await form.getByLabel("Demo key").fill("not the key");
  await form.getByRole("button", { name: "Open the demo" }).click();
  await expect(form.getByText("That demo key isn't right, or it was already used.")).toBeVisible({ timeout: 15_000 });
  await form.getByLabel("Demo key").fill(`  ${word.toUpperCase()} `);
  await form.getByRole("button", { name: "Open the demo" }).click();
  await expect(v.getByRole("heading", { name: `Hi, ${OWNER.name}.` })).toBeVisible({ timeout: 20_000 });

  // The family's keys and members, the account and Health stay closed.
  for (const path of ["/account", "/family", "/health"]) {
    await v.goto(path);
    await expect(v).toHaveURL(/\/$/);
  }
  const api = await v.request.post("/family", { headers: { "content-type": "text/plain" }, data: "x", maxRedirects: 0 });
  expect(api.status()).toBe(403);
  await visitor.close();

  // Used up: the same key doesn't work again.
  const second = await browser.newContext();
  const s = await second.newPage();
  await s.goto("/sign-in");
  await s.getByRole("button", { name: "Have a demo key?" }).click();
  await s.getByTestId("demo-key-form").getByLabel("Demo key").fill(word);
  await s.getByTestId("demo-key-form").getByRole("button", { name: "Open the demo" }).click();
  await expect(s.getByText("That demo key isn't right, or it was already used.")).toBeVisible({ timeout: 15_000 });
  await second.close();

  // The owner's own session is untouched and sees the key as used.
  await page.goto("/account");
  await expect(page.getByTestId("demo-keys")).toContainText(/Key \d+: used/);
  expect(errors).toEqual([]);
});
