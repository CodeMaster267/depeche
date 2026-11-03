import { expect, test } from "@playwright/test";
import { OWNER, admin, latestEmail } from "./helpers";

/**
 * Runs once before the other browser tests: wipes the local database and sets Depeche up the way
 * Hasan will on day one, through the setup page and the emailed link.
 */
test("first-time setup: the owner creates Depeche and their family", async ({ page }) => {
  const db = admin();
  for (const table of ["invites", "usage_events", "memories", "messages", "chats", "provider_keys", "profiles", "families"]) {
    const { error } = await db.from(table).delete().not("id", "is", null);
    expect(error, `clearing ${table}`).toBeNull();
  }
  const { data } = await db.auth.admin.listUsers({ perPage: 1000 });
  for (const u of data.users) await db.auth.admin.deleteUser(u.id);

  // Before there is an owner, sign-in sends you to setup.
  await page.goto("/");
  await expect(page).toHaveURL(/\/setup$/);

  // Someone else's email is refused.
  await page.getByLabel("Your name").fill("Mallory");
  await page.getByLabel("Your family's name").fill("Takeover");
  await page.getByLabel("Your email (the owner's)").fill("mallory@example.com");
  await page.getByRole("button", { name: "Email me a link to finish" }).click();
  await expect(page.locator("p[role=alert]")).toHaveText("That isn't the owner's email address.");

  const sentAt = Date.now() - 1000;
  await page.getByLabel("Your name").fill(OWNER.name);
  await page.getByLabel("Your family's name").fill("Khan family");
  await page.getByLabel("Your email (the owner's)").fill(OWNER.email);
  await page.getByRole("button", { name: "Email me a link to finish" }).click();
  await expect(page.getByText(/Tap the link in the email to finish/)).toBeVisible();

  const { link } = await latestEmail(OWNER.email, sentAt);
  await page.goto(link);
  await expect(page.getByRole("heading", { name: "Hi, Hasan." })).toBeVisible();

  // Setup is closed for good.
  await page.goto("/setup");
  await expect(page).toHaveURL(/\/$/);

  // Give the owner a password so the other tests can sign in quickly.
  const { data: users } = await db.auth.admin.listUsers();
  const owner = users.users.find((u) => u.email === OWNER.email)!;
  await db.auth.admin.updateUserById(owner.id, { password: OWNER.password });
});
