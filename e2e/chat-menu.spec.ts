import { expect, test, type Page } from "@playwright/test";
import { OWNER, admin, noSidewaysScroll, signInWithPassword, uniqueEmail, watchErrors } from "./helpers";

/**
 * The three dots on a chat (in the chat list and in the open chat's header): rename, pin, archive
 * and restore, delete; the archived chats view; and the new chat button inside a chat.
 */

/** A member of their own with a few chats, so these tests never touch anyone else's list. */
async function member(page: Page, titles: string[]) {
  const db = admin();
  const email = uniqueEmail("menu");
  const { data: user } = await db.auth.admin.createUser({ email, password: "member-password-123", email_confirm: true });
  const id = user.user!.id;
  const { data: owner } = await db.from("profiles").select("family_id").eq("is_app_owner", true).single();
  await db.from("profiles").insert({ id, family_id: owner!.family_id, display_name: "Mira" });
  const now = Date.now();
  const { data: chats } = await db
    .from("chats")
    .insert(titles.map((title, i) => ({ owner_id: id, title, updated_at: new Date(now - i * 60_000).toISOString() })))
    .select("id, title");
  await signInWithPassword(page, email, "member-password-123");
  await expect(page.getByRole("heading", { name: "Hi, Mira." })).toBeVisible();
  return { db, id, chats: Object.fromEntries((chats ?? []).map((c) => [c.title, c.id as string])) };
}

/** The chat list: the sidebar on wide screens, the drawer on phones. */
const phone = (page: Page) => (page.viewportSize()?.width ?? 1000) < 768;

async function chatList(page: Page) {
  if (phone(page)) await page.getByRole("button", { name: "Open menu" }).click();
  const nav = page.getByRole("navigation", { name: "Chats" }).filter({ visible: true });
  await expect(nav).toBeVisible();
  return nav;
}

async function closeList(page: Page) {
  if (phone(page)) await page.getByRole("navigation", { name: "Chats" }).getByRole("button", { name: "Close menu" }).click();
}

test("rename, pin, archive, restore and delete from a chat's three dots in the list", async ({ page }) => {
  const errors = watchErrors(page);
  const { db, id } = await member(page, ["Trip to Lahore", "Chemistry revision", "Birthday ideas"]);
  let list = await chatList(page);

  // Rename: the sheet starts with the old name, and the new one shows straight away and is saved.
  await list.getByRole("button", { name: "Options for Chemistry revision" }).click();
  const menu = page.getByRole("menu", { name: "Options for Chemistry revision" });
  await expect(menu.getByRole("menuitem")).toHaveText(["Rename", "Pin", "Archive", "Move to project", "Delete"]);
  await noSidewaysScroll(page);
  await menu.getByRole("menuitem", { name: "Rename" }).click();
  const rename = page.getByRole("dialog", { name: "Rename chat" });
  await expect(rename.getByLabel("Chat name")).toHaveValue("Chemistry revision");
  await rename.getByLabel("Chat name").fill("  Chemistry   exam  ");
  await rename.getByRole("button", { name: "Save" }).click();
  await expect(rename).toHaveCount(0);
  await expect(list.getByRole("link", { name: "Chemistry exam", exact: true })).toBeVisible();
  await expect.poll(async () => (await db.from("chats").select("title").eq("owner_id", id).order("title")).data?.map((c) => c.title)).toEqual([
    "Birthday ideas",
    "Chemistry exam",
    "Trip to Lahore",
  ]);

  // Pin moves it into Pinned.
  await list.getByRole("button", { name: "Options for Birthday ideas" }).click();
  await page.getByRole("menuitem", { name: "Pin" }).click();
  await expect(list.getByRole("heading", { name: "Pinned" })).toBeVisible();
  await expect(list.locator("section").first().getByRole("link")).toHaveText(["Birthday ideas"]);

  // Archive takes it out of the list and keeps it.
  await list.getByRole("button", { name: "Options for Trip to Lahore" }).click();
  await page.getByRole("menuitem", { name: "Archive" }).click();
  await expect(list.getByRole("link", { name: "Trip to Lahore" })).toHaveCount(0);
  await expect.poll(async () => (await db.from("chats").select("archived_at").eq("owner_id", id).eq("title", "Trip to Lahore").single()).data?.archived_at).not.toBeNull();

  // Still archived after a reload, and found under Archived chats, where it can be restored.
  await page.reload();
  list = await chatList(page);
  await expect(list.getByRole("link", { name: "Trip to Lahore" })).toHaveCount(0);
  await list.getByRole("button", { name: "Archived chats" }).click();
  await expect(list.getByRole("heading", { name: "Archived" })).toBeVisible();
  await expect(list.locator("section").getByRole("link")).toHaveText(["Trip to Lahore"]);
  await list.getByRole("button", { name: "Options for Trip to Lahore" }).click();
  await expect(page.getByRole("menu").getByRole("menuitem")).toHaveText(["Rename", "Restore", "Move to project", "Delete"]);
  await page.getByRole("menuitem", { name: "Restore" }).click();
  await expect(list.getByText("No archived chats.")).toBeVisible();
  await list.getByRole("button", { name: "All chats" }).click();
  await expect(list.getByRole("link", { name: "Trip to Lahore" })).toBeVisible();

  // Delete asks first; Cancel keeps it, Delete removes it for good.
  await list.getByRole("button", { name: "Options for Chemistry exam" }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  const confirm = page.getByRole("dialog", { name: "Delete chat" });
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(list.getByRole("link", { name: "Chemistry exam" })).toBeVisible();
  await list.getByRole("button", { name: "Options for Chemistry exam" }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await confirm.getByRole("button", { name: "Delete" }).click();
  await expect(confirm).toHaveCount(0);
  await expect(list.getByRole("link", { name: "Chemistry exam" })).toHaveCount(0);
  await expect.poll(async () => (await db.from("chats").select("title").eq("owner_id", id).order("title")).data?.map((c) => c.title)).toEqual([
    "Birthday ideas",
    "Trip to Lahore",
  ]);
  expect(errors).toEqual([]);
});

test("an open chat's header has the same menu and a new chat button", async ({ page }) => {
  const errors = watchErrors(page);
  const { db, chats } = await member(page, ["Garden plans", "Recipes"]);
  await page.goto(`/c/${chats["Garden plans"]}`);
  await expect(page.getByRole("heading", { level: 1, name: "Garden plans" })).toBeVisible();

  // The new chat button is there at every screen size, as glass.
  const newChat = page.getByRole("banner").getByRole("link", { name: "New chat" });
  await expect(newChat).toBeVisible();
  await expect(newChat).toHaveClass(/glass/);
  const box = (await newChat.boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(40);

  // Rename from the header.
  await page.getByRole("button", { name: "Chat options" }).click();
  await page.getByRole("menuitem", { name: "Rename" }).click();
  await page.getByRole("dialog", { name: "Rename chat" }).getByLabel("Chat name").fill("Garden for spring");
  await page.getByRole("dialog", { name: "Rename chat" }).getByLabel("Chat name").press("Enter");
  await expect(page.getByRole("heading", { level: 1, name: "Garden for spring" })).toBeVisible();

  // Archive from the header: the chat stays open with a note and a way back.
  await page.getByRole("button", { name: "Chat options" }).click();
  await page.getByRole("menuitem", { name: "Archive" }).click();
  await expect(page.getByText("This chat is archived.")).toBeVisible();
  const list = await chatList(page);
  await expect(list.getByRole("link", { name: "Garden for spring" })).toHaveCount(0);
  await closeList(page);
  await page.getByRole("status").getByRole("button", { name: "Restore" }).click();
  await expect(page.getByText("This chat is archived.")).toHaveCount(0);
  await expect.poll(async () => (await db.from("chats").select("archived_at").eq("id", chats["Garden plans"]).single()).data?.archived_at).toBeNull();

  // New chat opens an empty chat.
  await newChat.click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { name: "Hi, Mira." })).toBeVisible();

  // Deleting the open chat from its header goes to a new chat.
  await page.goto(`/c/${chats["Recipes"]}`);
  await page.getByRole("button", { name: "Chat options" }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page.getByRole("dialog", { name: "Delete chat" }).getByRole("button", { name: "Delete" }).click();
  await expect(page.getByRole("heading", { name: "Hi, Mira." })).toBeVisible();
  await expect.poll(async () => (await db.from("chats").select("id").eq("id", chats["Recipes"])).data?.length).toBe(0);
  expect(errors).toEqual([]);
});

test("new chat starts over even in a chat begun on the home screen", async ({ page }) => {
  await signInWithPassword(page, OWNER.email, OWNER.password);
  await expect(page.getByRole("heading", { name: "Hi, Hasan." })).toBeVisible();
  // The family needs a key before there's a model to chat with (test keys start with "test-").
  await page.goto("/family");
  const row = page.getByTestId("provider-google");
  await expect(row.getByText(/Not added|ends in/)).toBeVisible();
  if (await row.getByText("Not added").isVisible()) {
    await row.getByLabel("Google (Gemini) API key").fill("test-google-key-1234567890abcd");
    await row.getByRole("button", { name: "Save key" }).click();
    await expect(row.getByText(/ends in/)).toBeVisible();
  }
  await page.goto("/");
  const words = `menu test ${Math.random().toString(36).slice(2, 7)}`;
  await page.getByLabel("Message Depeche").fill(words);
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page).toHaveURL(/\/c\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId("user-message").filter({ hasText: words })).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop" })).toHaveCount(0, { timeout: 30_000 });

  await page.getByRole("banner").getByRole("link", { name: "New chat" }).click();
  await expect(page.getByRole("heading", { name: "Hi, Hasan." })).toBeVisible();
  await expect(page.getByTestId("user-message")).toHaveCount(0);
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByLabel("Message Depeche")).toHaveValue("");
});
