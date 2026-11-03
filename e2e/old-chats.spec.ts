import { expect, test } from "@playwright/test";
import { admin, signInWithPassword, uniqueEmail } from "./helpers";

/** Old chats are deleted after a month unless pinned or the person keeps their chats. */
test("people can choose to keep their chats, and the daily clean-up respects it", async ({ page }) => {
  // A member of their own, so the switch doesn't affect other tests.
  const db = admin();
  const email = uniqueEmail("keeper");
  const { data: user } = await db.auth.admin.createUser({ email, password: "member-password-123", email_confirm: true });
  const id = user.user!.id;
  const { data: owner } = await db.from("profiles").select("family_id").eq("is_app_owner", true).single();
  await db.from("profiles").insert({ id, family_id: owner!.family_id, display_name: "Keeper" });
  const longAgo = new Date(Date.now() - 40 * 86_400_000).toISOString();
  const inserted = await db.from("chats").insert([
    { owner_id: id, title: "Kept old chat", pinned: false, updated_at: longAgo },
    { owner_id: id, title: "Pinned old chat", pinned: true, updated_at: longAgo },
  ]);
  expect(inserted.error).toBeNull();

  await signInWithPassword(page, email, "member-password-123");
  await expect(page.getByRole("heading", { name: "Hi, Keeper." })).toBeVisible();
  await page.goto("/account");
  const toggle = page.getByRole("switch", { name: "Keep all my chats" });
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(page.getByText(/haven't used for a month are deleted/)).toBeVisible();
  await toggle.click();
  await expect(page.getByText("Your chats are kept until you delete them.")).toBeVisible();
  await expect.poll(async () => (await db.from("profiles").select("keep_chats").eq("id", id).single()).data?.keep_chats).toBe(true);
  await page.reload();
  await expect(page.getByRole("switch", { name: "Keep all my chats" })).toHaveAttribute("aria-checked", "true");

  // Kept: the clean-up leaves both chats.
  expect((await page.request.get("/api/cleanup")).ok()).toBe(true);
  const titles = async () => ((await db.from("chats").select("title").eq("owner_id", id).order("title")).data ?? []).map((c) => c.title);
  expect(await titles()).toEqual(["Kept old chat", "Pinned old chat"]);

  // Switched back off: the old chat goes, the pinned one stays.
  await page.getByRole("switch", { name: "Keep all my chats" }).click();
  await expect.poll(async () => (await db.from("profiles").select("keep_chats").eq("id", id).single()).data?.keep_chats).toBe(false);
  expect((await page.request.get("/api/cleanup")).ok()).toBe(true);
  expect(await titles()).toEqual(["Pinned old chat"]);
});
