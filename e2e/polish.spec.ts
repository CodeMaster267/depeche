import { expect, test, type Page } from "@playwright/test";
import { OWNER, noSidewaysScroll, signInWithPassword, watchErrors } from "./helpers";

/**
 * The calmer chats list (one account row instead of a wall of buttons beside the name) and the
 * waiting line shown before a reply's first word.
 */

async function signInOwner(page: Page) {
  await signInWithPassword(page, OWNER.email, OWNER.password);
  await expect(page.getByRole("heading", { name: "Hi, Hasan." })).toBeVisible();
}

async function openChats(page: Page) {
  const open = page.getByRole("button", { name: "Open menu" });
  if (await open.isVisible()) await open.click();
}

async function ensureGoogleKey(page: Page) {
  await page.goto("/family");
  const row = page.getByTestId("provider-google");
  await expect(row.getByText(/Not added|ends in/)).toBeVisible();
  if (await row.getByText("Not added").isVisible()) {
    await row.getByLabel("Google (Gemini) API key").fill("test-google-key-1234567890abcd");
    await row.getByRole("button", { name: "Save key" }).click();
    await expect(row.getByText(/ends in/)).toBeVisible();
  }
}

test("the account row opens a menu with your pages, and closes again", async ({ page }) => {
  const errors = watchErrors(page);
  await signInOwner(page);
  await openChats(page);
  const account = page.getByRole("button", { name: "Hasan, account menu" });
  await expect(account).toBeVisible();
  await expect(account).toContainText(/\$\d+\.\d\d of \$\d+ this month/);
  // Nothing but the row sits beside the name until it is opened.
  await expect(page.getByRole("link", { name: "Memory", exact: true })).toHaveCount(0);

  await account.click();
  await expect(account).toHaveAttribute("aria-expanded", "true");
  const menu = page.getByRole("navigation", { name: "Your pages" });
  for (const name of ["Memory", "My look", "Account", "Family", "Health", "Report a bug"]) {
    await expect(menu.getByRole("link", { name, exact: true })).toBeVisible();
  }
  await expect(page.getByTestId("spending")).toBeVisible();
  await noSidewaysScroll(page);

  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(account).toBeFocused();

  await account.click();
  await expect(menu).toBeVisible();
  // A tap anywhere else closes it.
  await page.mouse.click(5, 5);
  await expect(menu).toHaveCount(0);

  await account.click();
  await menu.getByRole("link", { name: "Memory", exact: true }).click();
  await expect(page).toHaveURL(/\/memory$/);
  expect(errors).toEqual([]);
});

test("while a reply hasn't started, a waiting line says what's happening and counts the seconds", async ({ page }) => {
  await signInOwner(page);
  await ensureGoogleKey(page);
  await page.goto("/");
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route("**/api/chat", async (route) => {
    await held;
    await route.continue().catch(() => {});
  });
  await page.getByLabel("Message Depeche").fill(`Waiting test ${Date.now()}`);
  await page.getByRole("button", { name: "Send" }).click();

  const waiting = page.getByTestId("waiting");
  await expect(waiting).toBeVisible();
  await expect(waiting).toContainText(/asking .+/);
  await expect(waiting).toContainText("thinking", { timeout: 6_000 });
  await expect(waiting).toContainText(/[3-9]s$/, { timeout: 6_000 });

  release();
  await expect(waiting).toHaveCount(0, { timeout: 20_000 });
  await expect(page.getByTestId("reply").last()).not.toHaveAttribute("aria-busy", "true", { timeout: 30_000 });
});

test("with reduced motion the waiting line doesn't flip its letters", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await signInOwner(page);
  await ensureGoogleKey(page);
  await page.goto("/");
  await page.route("**/api/chat", () => {});
  await page.getByLabel("Message Depeche").fill(`Still waiting ${Date.now()}`);
  await page.getByRole("button", { name: "Send" }).click();
  const waiting = page.getByTestId("waiting");
  await expect(waiting).toContainText("thinking", { timeout: 6_000 });
  await expect(waiting.locator(".waiting-flip")).toHaveCount(0);
  expect(await waiting.locator(".waiting-signal").evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
});
