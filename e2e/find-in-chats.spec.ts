import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { OWNER, admin, noSidewaysScroll, signInWithPassword, uniqueEmail, watchErrors } from "./helpers";

/**
 * The search box above the chat list finds words inside messages, not only chat titles, shows the
 * matching chat with a snippet, and opens the chat at that message. It only ever searches the
 * signed-in person's own chats: their family admin (here the owner, Hasan) finds nothing of theirs,
 * even when the member shares chat titles.
 */
test("search finds words inside messages and opens the chat at the message", async ({ page }) => {
  const errors = watchErrors(page);
  const db = admin();
  const email = uniqueEmail("finder");
  const { data: user } = await db.auth.admin.createUser({ email, password: "member-password-123", email_confirm: true });
  const me = user.user!.id;
  const { data: owner } = await db.from("profiles").select("family_id").eq("is_app_owner", true).single();
  expect((await db.from("profiles").insert({ id: me, family_id: owner!.family_id, display_name: "Finder", share_titles: true })).error).toBeNull();

  const word = `Quokka${Date.now().toString(36)}`;
  const chat = randomUUID();
  const other = randomUUID();
  expect(
    (
      await db.from("chats").insert([
        { id: chat, owner_id: me, title: "Holiday plans", updated_at: new Date().toISOString() },
        { id: other, owner_id: me, title: `${word} title chat`, updated_at: new Date(Date.now() - 3_600_000).toISOString() },
      ])
    ).error,
  ).toBeNull();
  // A long chat, so the matching message starts well out of view.
  const rows = [];
  let parent: string | null = null;
  const t0 = Date.now() - 600_000;
  for (let i = 0; i < 30; i++) {
    const id = randomUUID();
    const target = i === 6;
    const text = target
      ? `${"We talked about the weather for a while. ".repeat(8)}Then the ${word} at the zoo was the best part, worth the £18 ticket. ${"And more. ".repeat(10)}`
      : `Message ${i}: ${"Some ordinary words about the trip. ".repeat(4)}`;
    rows.push({ id, chat_id: chat, owner_id: me, parent_id: parent, role: i % 2 ? "assistant" : "user", content: { text }, created_at: new Date(t0 + i * 1000).toISOString() });
    parent = id;
  }
  expect((await db.from("messages").insert(rows)).error).toBeNull();
  const target = rows[6].id;

  await signInWithPassword(page, email, "member-password-123");
  await expect(page.getByRole("heading", { name: "Hi, Finder." })).toBeVisible();
  const narrow = (page.viewportSize()?.width ?? 1000) < 768;
  if (narrow) await page.getByRole("button", { name: "Open menu" }).click();
  const nav = page.getByRole("navigation", { name: "Chats" }).last();
  const box = nav.getByLabel("Search chats");

  // Title matches as before, plus the chat whose message has the word, with a snippet.
  await box.fill(word.toLowerCase());
  await expect(nav.getByRole("link", { name: `${word} title chat` })).toBeVisible();
  const hit = nav.getByTestId("message-hit");
  await expect(hit).toHaveCount(1);
  await expect(hit).toContainText("Holiday plans");
  await expect(hit).toContainText(`You: …`);
  await expect(hit.locator("mark")).toHaveText(word);
  await noSidewaysScroll(page);

  // Codes and prices are found too.
  await box.fill("£18 ticket");
  await expect(nav.getByTestId("message-hit")).toContainText("Holiday plans");

  // Nothing found says so.
  await box.fill("xylophonezzz");
  await expect(nav.getByText("No chats or messages match “xylophonezzz”.")).toBeVisible();

  // Opening the result scrolls to that message and marks it.
  await box.fill(word);
  await nav.getByTestId("message-hit").click();
  await expect(page).toHaveURL(new RegExp(`/c/${chat}$`));
  const found = page.locator(`[data-message-id="${target}"] [data-testid="user-message"]`);
  await expect(found).toBeInViewport();
  await expect(found).toHaveAttribute("data-found", "true");
  await expect(found).not.toHaveAttribute("data-found", "true", { timeout: 5_000 });
  expect(errors.filter((e) => !/_rsc=.*access control checks/.test(e))).toEqual([]);
});

test("a family admin's search never finds a member's messages", async ({ page }) => {
  const db = admin();
  const email = uniqueEmail("private");
  const { data: user } = await db.auth.admin.createUser({ email, password: "member-password-123", email_confirm: true });
  const me = user.user!.id;
  const { data: owner } = await db.from("profiles").select("family_id").eq("is_app_owner", true).single();
  await db.from("profiles").insert({ id: me, family_id: owner!.family_id, display_name: "Private", share_titles: true });
  const word = `Secretword${Date.now().toString(36)}`;
  const chat = randomUUID();
  await db.from("chats").insert({ id: chat, owner_id: me, title: "Private chat" });
  await db.from("messages").insert({ chat_id: chat, owner_id: me, role: "user", content: { text: `My ${word} is here.` } });

  await signInWithPassword(page, OWNER.email, OWNER.password);
  await expect(page.getByRole("heading", { name: "Hi, Hasan." })).toBeVisible();
  if ((page.viewportSize()?.width ?? 1000) < 768) await page.getByRole("button", { name: "Open menu" }).click();
  const nav = page.getByRole("navigation", { name: "Chats" }).last();
  await nav.getByLabel("Search chats").fill(word);
  await expect(nav.getByText(`No chats or messages match “${word}”.`)).toBeVisible();
  await expect(nav.getByTestId("message-hit")).toHaveCount(0);
});

test("a match in an earlier version of a message opens that version", async ({ page }) => {
  const db = admin();
  const email = uniqueEmail("versions");
  const { data: user } = await db.auth.admin.createUser({ email, password: "member-password-123", email_confirm: true });
  const me = user.user!.id;
  const { data: owner } = await db.from("profiles").select("family_id").eq("is_app_owner", true).single();
  await db.from("profiles").insert({ id: me, family_id: owner!.family_id, display_name: "Versions" });
  const word = `Wombat${Date.now().toString(36)}`;
  const chat = randomUUID();
  const [q1, old, a1, edited, a2] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const at = (s: number) => new Date(Date.now() - 600_000 + s * 1000).toISOString();
  await db.from("chats").insert({ id: chat, owner_id: me, title: "Animals", updated_at: at(9) });
  expect(
    (
      await db.from("messages").insert([
        { id: q1, chat_id: chat, owner_id: me, parent_id: null, role: "user", content: { text: "Tell me about animals." }, created_at: at(1) },
        { id: a1, chat_id: chat, owner_id: me, parent_id: q1, role: "assistant", content: { text: "Sure." }, created_at: at(2) },
        // The first version of the question, later edited.
        { id: old, chat_id: chat, owner_id: me, parent_id: a1, role: "user", content: { text: `What does a ${word} eat?` }, created_at: at(3) },
        { id: edited, chat_id: chat, owner_id: me, parent_id: a1, role: "user", content: { text: "What does a koala eat?" }, created_at: at(4) },
        { id: a2, chat_id: chat, owner_id: me, parent_id: edited, role: "assistant", content: { text: "Eucalyptus." }, created_at: at(5) },
      ])
    ).error,
  ).toBeNull();

  await signInWithPassword(page, email, "member-password-123");
  await expect(page.getByRole("heading", { name: "Hi, Versions." })).toBeVisible();
  if ((page.viewportSize()?.width ?? 1000) < 768) await page.getByRole("button", { name: "Open menu" }).click();
  const nav = page.getByRole("navigation", { name: "Chats" }).last();
  await nav.getByLabel("Search chats").fill(word);
  await nav.getByTestId("message-hit").click();
  await expect(page).toHaveURL(new RegExp(`/c/${chat}$`));
  const found = page.locator(`[data-message-id="${old}"] [data-testid="user-message"]`);
  await expect(found).toHaveText(`What does a ${word} eat?`);
  await expect(found).toBeInViewport();
  await expect(page.getByText("What does a koala eat?")).toHaveCount(0);
});
