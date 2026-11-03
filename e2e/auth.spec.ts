import { expect, test, type Browser } from "@playwright/test";
import {
  OWNER,
  createInvite,
  emailCount,
  latestEmail,
  noSidewaysScroll,
  signInWithPassword,
  uniqueEmail,
  watchErrors,
} from "./helpers";

/** A fresh browser with nobody signed in, using the same device settings as the test. */
async function freshPage(browser: Browser, contextOptions: object) {
  const ctx = await browser.newContext(contextOptions);
  return ctx.newPage();
}

test.describe("signing in", () => {
  test("pages need you to be signed in", async ({ page }) => {
    for (const path of ["/", "/family", "/account"]) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/sign-in$/);
    }
  });

  test("the owner signs in with email and password", async ({ page }) => {
    const errors = watchErrors(page);
    await signInWithPassword(page, OWNER.email, OWNER.password);
    await expect(page.getByRole("heading", { name: "Hi, Hasan." })).toBeVisible();
    await expect(page.getByRole("link", { name: "Family" })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("a wrong password is refused without saying which part was wrong", async ({ page }) => {
    await signInWithPassword(page, OWNER.email, "not-the-password");
    await expect(page.locator("p[role=alert]")).toHaveText("That username or password isn't right.");
    await signInWithPassword(page, "nobody-here", "whatever-password");
    await expect(page.locator("p[role=alert]")).toHaveText("That username or password isn't right.");
  });

  test("an email that isn't in Depeche gets the same answer, and no email is sent", async ({ page }) => {
    const stranger = uniqueEmail("stranger");
    await page.goto("/sign-in");
    await page.getByLabel("Email address").fill(stranger);
    await page.getByRole("button", { name: "Send me a sign-in link" }).click();
    await expect(page.getByText(/If .* has a Depeche account/)).toBeVisible();
    await page.waitForTimeout(1500);
    expect(await emailCount(stranger)).toBe(0);
  });

  test("Continue with Google starts a secure Google sign-in that returns to Depeche", async ({ page }) => {
    // Stop at Supabase's door to Google: real Google can't be used in tests.
    let asked = "";
    await page.route("**/auth/v1/authorize**", (route) => {
      asked = route.request().url();
      return route.fulfill({ body: "Google sign-in (stub)" });
    });
    await page.goto("/sign-in");
    await page.getByRole("button", { name: "Continue with Google" }).click();
    await expect(page.getByText("Google sign-in (stub)")).toBeVisible();
    const url = new URL(asked);
    expect(url.searchParams.get("provider")).toBe("google");
    expect(new URL(url.searchParams.get("redirect_to")!).pathname).toBe("/auth/callback");
    expect(url.searchParams.get("code_challenge_method")?.toLowerCase()).toBe("s256");
  });

  test("an invite link that doesn't exist says so", async ({ page }) => {
    await page.goto("/invite/not-a-real-token");
    await expect(page.locator("p[role=alert]")).toHaveText(/isn't valid/);
  });
});

test.describe("invites and families", () => {
  test("invite → join with a username and password → sign in with the username", async ({ page, browser, contextOptions }) => {
    const email = uniqueEmail("pw");
    const username = `u${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;

    await signInWithPassword(page, OWNER.email, OWNER.password);
    await expect(page.getByRole("heading", { name: "Hi, Hasan." })).toBeVisible();
    const link = await createInvite(page, "Amir", email);

    const guest = await freshPage(browser, contextOptions);
    const errors = watchErrors(guest);
    await guest.goto(link);
    await expect(guest.getByText("Amir, you're invited to join")).toBeVisible();
    await expect(guest.getByText("Khan family")).toBeVisible();
    await noSidewaysScroll(guest);
    await guest.getByLabel("Username (optional)").fill(username.toUpperCase());
    await guest.getByLabel("Password").fill("short");
    await guest.getByRole("button", { name: "Join Depeche" }).click();
    // The browser blocks a too-short password before it is sent.
    await expect(guest).toHaveURL(link);
    await guest.getByLabel("Password").fill("amir-password-123");
    await guest.getByRole("button", { name: "Join Depeche" }).click();
    await expect(guest.getByRole("heading", { name: "Hi, Amir." })).toBeVisible();
    // Members have no family page.
    await expect(guest.getByRole("link", { name: "Family" })).toHaveCount(0);
    await guest.goto("/family");
    await expect(guest).toHaveURL(/\/$/);

    // The link is single-use.
    const other = await freshPage(browser, contextOptions);
    await other.goto(link);
    await expect(other.locator("p[role=alert]")).toHaveText(/already been used/);

    // Sign out, then back in with the username.
    await guest.goto("/account");
    await guest.getByRole("button", { name: "Sign out" }).click();
    await expect(guest).toHaveURL(/\/sign-in$/);
    await signInWithPassword(guest, username, "amir-password-123");
    await expect(guest.getByRole("heading", { name: "Hi, Amir." })).toBeVisible();
    expect(errors).toEqual([]);

    // The admin sees Amir in the family.
    await page.goto("/family");
    await expect(page.getByText(`@${username}`)).toBeVisible();
  });

  test("invite → join with the emailed link", async ({ page, browser, contextOptions }) => {
    const email = uniqueEmail("link");
    await signInWithPassword(page, OWNER.email, OWNER.password);
    await expect(page.getByRole("heading", { name: "Hi, Hasan." })).toBeVisible();
    const invite = await createInvite(page, "Sara", email);

    const guest = await freshPage(browser, contextOptions);
    await guest.goto(invite);
    const sentAt = Date.now() - 1000;
    await guest.getByRole("button", { name: "Email me a link to join" }).click();
    await expect(guest.getByText(/Tap the link in the email to join/)).toBeVisible();
    const { link } = await latestEmail(email, sentAt);
    await guest.goto(link);
    await expect(guest.getByRole("heading", { name: "Hi, Sara." })).toBeVisible();
  });

  test("invite → join with the code from the email, then sign in again with a code", async ({ page, browser, contextOptions }) => {
    const email = uniqueEmail("code");
    await signInWithPassword(page, OWNER.email, OWNER.password);
    await expect(page.getByRole("heading", { name: "Hi, Hasan." })).toBeVisible();
    const invite = await createInvite(page, "Zain", email);

    const guest = await freshPage(browser, contextOptions);
    await guest.goto(invite);
    let sentAt = Date.now() - 1000;
    await guest.getByRole("button", { name: "Email me a link to join" }).click();
    await guest.getByLabel("Code from the email").fill((await latestEmail(email, sentAt)).code);
    await guest.getByRole("button", { name: "Continue" }).click();
    await expect(guest.getByRole("heading", { name: "Hi, Zain." })).toBeVisible();

    await guest.context().clearCookies();
    await guest.waitForTimeout(1500); // Supabase allows one email per address per second here.
    await guest.goto("/sign-in");
    await guest.getByLabel("Email address").fill(email);
    sentAt = Date.now() - 1000;
    await guest.getByRole("button", { name: "Send me a sign-in link" }).click();
    await guest.getByLabel("Code from the email").fill("000000");
    await guest.getByRole("button", { name: "Continue" }).click();
    await expect(guest.locator("p[role=alert]")).toHaveText(/didn't work/);
    await guest.getByLabel("Code from the email").fill((await latestEmail(email, sentAt)).code);
    await guest.getByRole("button", { name: "Continue" }).click();
    await expect(guest.getByRole("heading", { name: "Hi, Zain." })).toBeVisible();
  });

  test("the admin sets a member's limit and resets their password", async ({ page, browser, contextOptions }) => {
    const email = uniqueEmail("reset");
    await signInWithPassword(page, OWNER.email, OWNER.password);
    await expect(page.getByRole("heading", { name: "Hi, Hasan." })).toBeVisible();
    const invite = await createInvite(page, "Noor", email);
    const guest = await freshPage(browser, contextOptions);
    await guest.goto(invite);
    await guest.getByLabel("Password").fill("noor-password-123");
    await guest.getByRole("button", { name: "Join Depeche" }).click();
    await expect(guest.getByRole("heading", { name: "Hi, Noor." })).toBeVisible();

    await page.goto("/family");
    await noSidewaysScroll(page);
    const noor = page.getByRole("listitem").filter({ hasText: "Noor" }).last();
    await noor.getByRole("button", { name: /Noor/ }).click();
    await noor.getByLabel("Monthly limit in dollars").fill("25");
    await noor.getByRole("button", { name: "Save limit" }).click();
    await expect(noor.getByText("Saved.")).toBeVisible();
    await expect(noor.getByText("of $25")).toBeVisible();

    await noor.getByLabel("New password for them").fill("brand-new-pass-456");
    await noor.getByRole("button", { name: "Reset their password" }).click();
    await expect(noor.getByText(/New password set/)).toBeVisible();

    const later = await freshPage(browser, contextOptions);
    await signInWithPassword(later, email, "noor-password-123");
    await expect(later.locator("p[role=alert]")).toBeVisible();
    await signInWithPassword(later, email, "brand-new-pass-456");
    await expect(later.getByRole("heading", { name: "Hi, Noor." })).toBeVisible();
  });

  test("the owner starts another family and invites its admin, then sees only its name", async ({ page, browser, contextOptions }) => {
    const email = uniqueEmail("admin");
    const family = `Friends ${Math.random().toString(36).slice(2, 7)}`;
    await signInWithPassword(page, OWNER.email, OWNER.password);
    await expect(page.getByRole("heading", { name: "Hi, Hasan." })).toBeVisible();
    await page.goto("/family");
    await page.getByLabel("Family name").fill(family);
    await page.getByLabel("Admin's name").fill("Bea");
    await page.getByLabel("Admin's email").fill(email);
    await page.getByRole("button", { name: "Create family and invite its admin" }).click();
    const link = (await page.getByTestId("invite-link").last().textContent())!.trim();

    const bea = await freshPage(browser, contextOptions);
    await bea.goto(link);
    await expect(bea.getByText(/as its admin/)).toBeVisible();
    await bea.getByLabel("Password").fill("bea-password-123");
    await bea.getByRole("button", { name: "Join Depeche" }).click();
    await expect(bea.getByRole("heading", { name: "Hi, Bea." })).toBeVisible();
    await bea.getByRole("link", { name: "Family" }).click();
    await expect(bea.getByRole("heading", { name: family })).toBeVisible();
    // Bea is not the owner, so she can't start families.
    await expect(bea.getByText("Other families")).toHaveCount(0);

    await page.reload();
    await expect(page.getByText(family)).toBeVisible();
    await expect(page.getByText("Bea")).toHaveCount(0);
  });

  test("people can change their name, username and password", async ({ page, browser, contextOptions }) => {
    const email = uniqueEmail("acct");
    await signInWithPassword(page, OWNER.email, OWNER.password);
    await expect(page.getByRole("heading", { name: "Hi, Hasan." })).toBeVisible();
    const invite = await createInvite(page, "Lina", email);
    const guest = await freshPage(browser, contextOptions);
    await guest.goto(invite);
    await guest.getByLabel("Password").fill("lina-password-123");
    await guest.getByRole("button", { name: "Join Depeche" }).click();
    await expect(guest.getByRole("heading", { name: "Hi, Lina." })).toBeVisible();

    await guest.goto("/account");
    await noSidewaysScroll(guest);
    await guest.getByLabel("Your name").fill("Lina K");
    await guest.getByLabel("Username").fill("has space");
    await guest.getByRole("button", { name: "Save", exact: true }).click();
    await expect(guest.locator("p[role=alert]")).toHaveText(/Usernames are/);
    const username = `l${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
    await guest.getByLabel("Username").fill(username);
    await guest.getByRole("button", { name: "Save", exact: true }).click();
    await expect(guest.getByText("Saved.")).toBeVisible();

    await guest.getByLabel("New password").fill("lina-new-password-1");
    await guest.getByRole("button", { name: "Set password" }).click();
    await expect(guest.getByText("Password changed.")).toBeVisible();

    const again = await freshPage(browser, contextOptions);
    await signInWithPassword(again, username, "lina-new-password-1");
    await expect(again.getByRole("heading", { name: "Hi, Lina K." })).toBeVisible();
  });
});
