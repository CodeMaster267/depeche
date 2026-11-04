import { expect, test, type Page } from "@playwright/test";
import { admin, noSidewaysScroll, signInWithPassword, uniqueEmail, watchErrors } from "./helpers";

/**
 * Chats the monthly clean-up is about to delete: a line at the top of the chat screen each day,
 * with Review → Keep / Keep all. Keeping restarts a chat's month without moving it in the list.
 */
async function member(page: Page) {
  const db = admin();
  const email = uniqueEmail("expiring");
  const { data: user } = await db.auth.admin.createUser({ email, password: "member-password-123", email_confirm: true });
  const id = user.user!.id;
  const { data: owner } = await db.from("profiles").select("family_id").eq("is_app_owner", true).single();
  await db.from("profiles").insert({ id, family_id: owner!.family_id, display_name: "Lina" });
  const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
  const inserted = await db.from("chats").insert([
    { owner_id: id, title: "Old holiday plans", updated_at: ago(29.5) },
    { owner_id: id, title: "Archived recipe", updated_at: ago(28), archived_at: ago(20) },
    { owner_id: id, title: "Fresh chat", updated_at: ago(1) },
  ]);
  expect(inserted.error).toBeNull();
  await signInWithPassword(page, email, "member-password-123");
  await expect(page.getByRole("heading", { name: "Hi, Lina." })).toBeVisible();
  return { db, id };
}

test("chats about to be deleted are shown each day and can be kept", async ({ page }) => {
  const errors = watchErrors(page);
  const { db, id } = await member(page);
  const notice = page.getByTestId("deletion-notice");
  await expect(notice).toContainText("2 chats will be deleted soon");
  await noSidewaysScroll(page);

  await notice.getByRole("button", { name: "Review" }).click();
  const sheet = page.getByRole("dialog", { name: "Chats about to be deleted" });
  await expect(sheet.getByRole("listitem")).toHaveCount(2);
  await expect(sheet.getByRole("listitem").first()).toContainText("Old holiday plans");
  await expect(sheet.getByRole("listitem").first()).toContainText("Deleted tomorrow");
  await expect(sheet.getByRole("listitem").nth(1)).toContainText("archived");

  // Keep one: it leaves the list, its month restarts, and it doesn't jump to the top of the chats.
  await sheet.getByRole("listitem").filter({ hasText: "Old holiday plans" }).getByRole("button", { name: "Keep" }).click();
  await expect(sheet.getByRole("listitem")).toHaveCount(1);
  await expect(notice).toContainText("1 chat will be deleted soon");
  const row = async (title: string) => (await db.from("chats").select("kept_at, updated_at").eq("owner_id", id).eq("title", title).single()).data!;
  await expect.poll(async () => (await row("Old holiday plans")).kept_at).not.toBeNull();
  expect(Date.now() - Date.parse((await row("Old holiday plans")).updated_at)).toBeGreaterThan(29 * 86_400_000);

  // Keep the rest: the sheet and the line go.
  await sheet.getByRole("button", { name: "Keep it" }).click();
  await expect(sheet).toHaveCount(0);
  await expect(notice).toHaveCount(0);
  await expect.poll(async () => (await row("Archived recipe")).kept_at).not.toBeNull();

  await page.reload();
  await expect(page.getByRole("heading", { name: "Hi, Lina." })).toBeVisible();
  await expect(notice).toHaveCount(0);

  // (That the clean-up then spares kept chats is proven in tests/db/chat-keep.test.ts; running the
  // real clean-up here would delete other tests' old chats while they run.)
  expect(errors).toEqual([]);
});

test("closing the line hides it until tomorrow", async ({ page }) => {
  await member(page);
  const notice = page.getByTestId("deletion-notice");
  await expect(notice).toBeVisible();
  await notice.getByRole("button", { name: "Hide until tomorrow" }).click();
  await expect(notice).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Hi, Lina." })).toBeVisible();
  await expect(notice).toHaveCount(0);

  // Tomorrow it's back while something is still due.
  await page.evaluate(() => localStorage.setItem("depeche:expiring-closed", "2000-01-01"));
  await page.reload();
  await expect(notice).toContainText("2 chats will be deleted soon");
});
