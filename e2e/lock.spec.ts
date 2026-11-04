import { expect, test, type Page } from "@playwright/test";
import { admin, noSidewaysScroll, signInWithPassword, uniqueEmail, watchErrors } from "./helpers";

/**
 * App lock: a PIN (and Face ID / Touch ID where the device has it) that people can put on
 * Depeche. Locked, the server lets nothing through but the lock screen.
 */
const PASSWORD = "member-password-123";
const PIN = "2580";

async function newPerson(page: Page, name: string) {
  const db = admin();
  const email = uniqueEmail("lock");
  const { data: user } = await db.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  const { data: owner } = await db.from("profiles").select("family_id").eq("is_app_owner", true).single();
  await db.from("profiles").insert({ id: user.user!.id, family_id: owner!.family_id, display_name: name });
  await signInWithPassword(page, email, PASSWORD);
  await expect(page.getByRole("heading", { name: `Hi, ${name}.` })).toBeVisible();
  return { id: user.user!.id, email };
}

async function turnOnLock(page: Page, timeoutLabel: string) {
  await page.goto("/account");
  // Wait until the page is interactive, so the form goes through the app and not a plain post.
  await expect(page.locator("form[data-ready]").first()).toBeAttached();
  await page.getByLabel("New PIN (4 to 8 digits)").fill(PIN);
  await page.getByLabel("Type the new PIN again").fill(PIN);
  await page.getByLabel("Lock Depeche").selectOption({ label: timeoutLabel });
  await page.getByRole("button", { name: "Turn on app lock" }).click();
  await expect(page.getByText("App lock is on.")).toBeVisible({ timeout: 15_000 });
}

/** Locks this device on the server, as the page does when it's left or the timer runs out. */
async function lockNow(page: Page) {
  const res = await page.request.post("/api/lock/lock");
  expect(res.ok()).toBe(true);
}

async function typePin(page: Page, pin: string, scope = page.getByTestId("lock-screen")) {
  for (const d of pin) await scope.getByRole("button", { name: d, exact: true }).click();
}

test("a PIN locks Depeche on the server, and unlocks it again", async ({ page }) => {
  const errors = watchErrors(page);
  await newPerson(page, "Lena");
  // Too-easy PINs are refused.
  await page.goto("/account");
  await expect(page.locator("form[data-ready]").first()).toBeAttached();
  await page.getByLabel("New PIN (4 to 8 digits)").fill("1234");
  await page.getByLabel("Type the new PIN again").fill("1234");
  await page.getByRole("button", { name: "Turn on app lock" }).click();
  await expect(page.getByText("too easy to guess")).toBeVisible();
  await turnOnLock(page, "After 5 minutes");

  await lockNow(page);
  await page.goto("/account");
  await expect(page).toHaveURL(/\/lock\?next=%2Faccount$/);
  await expect(page.getByText("Enter your PIN")).toBeVisible();
  await expect(page.getByTestId("pin-dots").locator("span")).toHaveCount(4);
  await noSidewaysScroll(page);

  // Nothing else gets through while locked: not the chat, not server actions, not pages.
  const chat = await page.request.post("/api/chat", { data: { text: "hi" } });
  expect(chat.status()).toBe(423);
  const html = await (await page.request.get("/", { maxRedirects: 0 })).text();
  expect(html).not.toContain("Lena");

  // A wrong PIN is refused and counted.
  await typePin(page, "1111");
  await expect(page.getByRole("alert").filter({ hasText: "Wrong PIN." })).toBeVisible();
  await expect(page).toHaveURL(/\/lock/);

  // The right one goes back where the person was. Keyboard typing works too.
  await page.keyboard.type(PIN);
  await expect(page).toHaveURL(/\/account$/);
  await expect(page.getByRole("heading", { name: "Account" })).toBeVisible();
  expect((await page.request.post("/api/chat", { data: {} })).status()).not.toBe(423);
  // Safari logs prefetches a navigation cancels (see helpers); that is not a fault here.
  expect(errors.filter((e) => !/_rsc=.*access control checks/is.test(e))).toEqual([]);
});

test("the page locks itself when left, keeps what was typed, and the lock can be turned off", async ({ page }) => {
  await newPerson(page, "Omar");
  await turnOnLock(page, "As soon as I leave Depeche");
  await page.goto("/account");
  await page.getByLabel("Your name").fill("half-typed name");

  // Leaving the app (switching apps on a phone) locks it at once.
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  });
  const cover = page.getByRole("dialog", { name: "Depeche is locked" });
  await expect(cover).toBeVisible();
  await expect(cover.getByText("Enter your PIN")).toBeVisible();
  // The server is locked too.
  await expect.poll(async () => (await page.request.post("/api/chat", { data: {} })).status()).toBe(423);
  await noSidewaysScroll(page);

  await typePin(page, PIN, cover);
  await expect(cover).toHaveCount(0);
  await expect(page.getByLabel("Your name")).toHaveValue("half-typed name");

  // A fresh sign-in on this device doesn't ask for the current PIN to turn the lock off.
  await page.reload();
  await page.getByText("Turn off app lock").first().click();
  await page.getByRole("button", { name: "Turn off app lock" }).click();
  await expect(page.getByRole("button", { name: "Turn on app lock" })).toBeVisible();
  await lockNow(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Hi, Omar." })).toBeVisible();
});

test("signing in again counts as unlocking (for a forgotten PIN)", async ({ page }) => {
  const who = await newPerson(page, "Ines");
  await turnOnLock(page, "After 1 minute");
  await lockNow(page);
  await page.goto("/");
  await expect(page).toHaveURL(/\/lock/);
  await page.getByRole("button", { name: "Forgot your PIN? Sign out" }).click();
  await expect(page).toHaveURL(/\/sign-in/);
  await signInWithPassword(page, who.email, PASSWORD);
  await expect(page.getByRole("heading", { name: "Hi, Ines." })).toBeVisible();
});

test("Face ID / Touch ID unlocks with a passkey", async ({ page, browserName }) => {
  // Chromium can fake a fingerprint reader; WebKit's automation can't, so Safari runs the PIN tests above.
  test.skip(browserName !== "chromium", "virtual authenticator is Chromium-only");
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });

  await newPerson(page, "Yusuf");
  await turnOnLock(page, "After 15 minutes");
  await page.goto("/account");
  await page.getByRole("button", { name: /^Set up .* on this device$/ }).click();
  await expect(page.getByText("You can unlock Depeche with it now.")).toBeVisible();
  await expect(page.getByTestId("passkeys")).toContainText(/Mac|Windows|Android|This device/);

  await lockNow(page);
  await page.goto("/");
  await expect(page).toHaveURL(/\/lock/);
  // This device made the passkey, so the lock screen asks for it straight away.
  await expect(page.getByRole("heading", { name: "Hi, Yusuf." })).toBeVisible();

  // And with the button.
  await lockNow(page);
  await page.evaluate(() => localStorage.removeItem("dp_passkey_here"));
  await page.goto("/");
  await expect(page).toHaveURL(/\/lock/);
  await page.getByRole("button", { name: /^Use / }).click();
  await expect(page.getByRole("heading", { name: "Hi, Yusuf." })).toBeVisible();
});
