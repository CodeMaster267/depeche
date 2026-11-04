import { expect, test, type Page } from "@playwright/test";
import { OWNER, admin, noSidewaysScroll, signInWithPassword, uniqueEmail, watchErrors } from "./helpers";

/**
 * Temporary chats (never saved, nothing remembered, gone on leaving) and share links (a read-only
 * copy of a chat that anyone with the link can open, until its owner stops sharing).
 */

/** A person of their own in the owner's family, which has a Google test key. */
async function person(page: Page, name: string) {
  const db = admin();
  const { data: owner } = await db.from("profiles").select("family_id").eq("is_app_owner", true).single();
  const { data: key } = await db.from("provider_keys").select("provider").eq("family_id", owner!.family_id).eq("provider", "google").maybeSingle();
  if (!key) {
    await signInWithPassword(page, OWNER.email, OWNER.password);
    await expect(page.getByRole("heading", { name: "Hi, Hasan." })).toBeVisible();
    await page.goto("/family");
    const row = page.getByTestId("provider-google");
    await expect(row.getByText(/Not added|ends in/)).toBeVisible();
    if (await row.getByText("Not added").isVisible()) {
      await row.getByLabel("Google (Gemini) API key").fill("test-google-key-1234567890abcd");
      await row.getByRole("button", { name: "Save key" }).click();
      await expect(row.getByText(/ends in/)).toBeVisible();
    }
    await page.context().clearCookies();
  }
  const email = uniqueEmail("wisp");
  const { data: user } = await db.auth.admin.createUser({ email, password: "member-password-123", email_confirm: true });
  const id = user.user!.id;
  await db.from("profiles").insert({ id, family_id: owner!.family_id, display_name: name, last_model: "gemini-3.8-flash" });
  await signInWithPassword(page, email, "member-password-123");
  await expect(page.getByRole("heading", { name: `Hi, ${name}.` })).toBeVisible();
  return { db, id };
}

async function send(page: Page, text: string) {
  await page.getByLabel("Message Depeche").fill(text);
  await page.getByRole("button", { name: "Send" }).click();
  const reply = page.getByTestId("reply").last();
  await expect(reply).toHaveAttribute("aria-busy", "true");
  await expect(reply).not.toHaveAttribute("aria-busy", "true", { timeout: 20_000 });
  return reply;
}

test("a temporary chat answers with its whole conversation, but nothing is saved or remembered", async ({ page }) => {
  const errors = watchErrors(page);
  const { db, id } = await person(page, "Tam");

  const toggle = page.getByRole("button", { name: "Temporary chat" });
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("temporary-note")).toContainText("won't be saved");
  await expect(page).toHaveURL(/\?temporary$/);
  await noSidewaysScroll(page);

  await send(page, "Secret plan: my favourite colour is teal");
  const second = await send(page, "What was my first message?");
  // The earlier turns reached the model, though the server keeps none of them.
  await expect(second).toContainText('Your first message was: "Secret plan: my favourite colour is teal" (3 turns)');
  // No memory is suggested, and the tag never shows.
  await expect(page.getByTestId("memory-suggestion")).toHaveCount(0);
  await expect(page.getByTestId("reply").first()).not.toContainText("<remember>");
  await expect(page.getByRole("heading", { name: "Temporary chat", level: 1 })).toBeVisible();
  await expect(page).not.toHaveURL(/\/c\//);

  // Try again works from what's on screen.
  await page.getByTestId("reply").last().getByRole("button", { name: "Try again" }).click();
  await expect(page.getByTestId("reply").last()).not.toHaveAttribute("aria-busy", "true", { timeout: 20_000 });
  await expect(page.getByTestId("reply").last()).toContainText("Your first message was");

  // Nothing was written: no chat, no messages, no memories. Only the cost counts towards the limit.
  expect((await db.from("chats").select("id").eq("owner_id", id)).data).toEqual([]);
  expect((await db.from("messages").select("id").eq("owner_id", id)).data).toEqual([]);
  expect((await db.from("memories").select("id").eq("owner_id", id)).data).toEqual([]);
  const { data: usage } = await db.from("usage_events").select("message_id, cost_usd").eq("owner_id", id);
  expect(usage?.length).toBe(3);
  expect(usage?.every((u) => u.message_id === null && Number(u.cost_usd) > 0)).toBe(true);

  // Leaving (here, a reload) and it's gone.
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Hi, Tam." })).toBeVisible();
  await expect(page.getByText("Secret plan")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("the New chat button leaves a temporary chat, and a normal chat is saved as usual", async ({ page }) => {
  const { db, id } = await person(page, "Nia");
  await page.goto("/?temporary");
  await expect(page.getByRole("button", { name: "Temporary chat" })).toHaveAttribute("aria-pressed", "true");
  await send(page, "Just between us");
  await page.locator("header").getByRole("link", { name: "New chat" }).click();
  await expect(page.getByRole("heading", { name: "Hi, Nia." })).toBeVisible();
  await expect(page.getByText("Just between us")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Temporary chat" })).toHaveAttribute("aria-pressed", "false");

  await send(page, "Keep this one");
  await expect(page).toHaveURL(/\/c\//);
  await expect.poll(async () => (await db.from("messages").select("id").eq("owner_id", id)).data?.length).toBe(2);
});

test("sharing a chat makes a read-only link that opens signed out, and stops working when sharing stops", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const { db, id } = await person(page, "Sol");
  await send(page, "Plan a picnic");
  await expect(page).toHaveURL(/\/c\//);

  await page.getByRole("button", { name: "Chat options" }).click();
  await page.getByRole("menuitem", { name: "Share" }).click();
  const sheet = page.getByRole("dialog", { name: "Share chat" });
  await expect(sheet).toContainText("Anyone with the link");
  await noSidewaysScroll(page);
  await sheet.getByRole("button", { name: "Create link" }).click();
  const link = sheet.getByTestId("share-link");
  await expect(link).toHaveValue(/\/s\/[A-Za-z0-9_-]{43}$/);
  const url = await link.inputValue();

  // Someone with no account opens it: the conversation shows, read only, with no way to write.
  const visitor = await browser.newContext();
  const other = await visitor.newPage();
  const otherErrors = watchErrors(other);
  await other.goto(url);
  await expect(other.getByRole("heading", { name: "Plan a picnic", level: 1 })).toBeVisible();
  await expect(other.getByTestId("user-message")).toHaveText("Plan a picnic");
  await expect(other.getByTestId("reply")).toContainText("Here's a worked answer");
  await expect(other.getByLabel("Message Depeche")).toHaveCount(0);
  await expect(other.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
  await noSidewaysScroll(other);

  // Later messages aren't in the copy until the owner updates it.
  await page.keyboard.press("Escape");
  await send(page, "Add sandwiches");
  await other.reload();
  await expect(other.getByTestId("user-message")).toHaveCount(1);
  await page.getByRole("button", { name: "Chat options" }).click();
  await page.getByRole("menuitem", { name: "Share" }).click();
  await expect(sheet.getByTestId("share-link")).toHaveValue(url);
  await sheet.getByRole("button", { name: "Update to now" }).click();
  await expect(sheet.getByRole("button", { name: "Update to now" })).toBeEnabled();
  await other.reload();
  await expect(other.getByTestId("user-message")).toHaveText(["Plan a picnic", "Add sandwiches"]);

  // Stop sharing: the link shows "doesn't work" at once.
  await sheet.getByRole("button", { name: "Stop sharing" }).click();
  await expect(sheet.getByRole("button", { name: "Create link" })).toBeVisible();
  await other.reload();
  await expect(other.getByRole("heading", { name: "This link doesn't work" })).toBeVisible();
  expect((await db.from("chat_shares").select("id").eq("owner_id", id)).data).toEqual([]);

  // A made-up link shows the same.
  await other.goto("/s/" + "x".repeat(43));
  await expect(other.getByRole("heading", { name: "This link doesn't work" })).toBeVisible();
  await visitor.close();
  expect(errors).toEqual([]);
  expect(otherErrors.filter((e) => !/404/.test(e))).toEqual([]);
});
