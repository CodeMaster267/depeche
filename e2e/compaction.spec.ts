import { expect, test, type Page } from "@playwright/test";
import { OWNER, admin, signInWithPassword, uniqueEmail } from "./helpers";

/**
 * Auto-compaction: a long chat gets a summary of its older part, shown as a tappable line. The
 * original messages stay. The summary can be redone, dropped, or turned off for the chat.
 */

async function familyHasGoogleKey(page: Page) {
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

/** A person of their own with a chat of `pairs` exchanges, each message about `tokens` tokens. */
async function longChat(tag: string, pairs: number, tokens: number) {
  const db = admin();
  const email = uniqueEmail(tag);
  const { data: user } = await db.auth.admin.createUser({ email, password: "member-password-123", email_confirm: true });
  const id = user.user!.id;
  const { data: owner } = await db.from("profiles").select("family_id").eq("is_app_owner", true).single();
  await db.from("profiles").insert({ id, family_id: owner!.family_id, display_name: "Lena", last_model: "gemini-3.8-flash" });
  const { data: chat } = await db
    .from("chats")
    .insert({ owner_id: id, title: "A very long chat", model: "gemini-3.8-flash" })
    .select("id")
    .single();
  const filler = "word ".repeat(Math.ceil((tokens * 4) / 5));
  let parent: string | null = null;
  const start = Date.now() - pairs * 60_000;
  for (let i = 0; i < pairs; i++) {
    for (const role of ["user", "assistant"] as const) {
      const text = i === 0 && role === "user" ? `Planning the boat trip. ${filler}` : `${role === "user" ? "Question" : "Answer"} ${i}. ${filler}`;
      const { data: m, error }: { data: { id: string } | null; error: unknown } = await db
        .from("messages")
        .insert({
          chat_id: chat!.id,
          owner_id: id,
          parent_id: parent,
          role,
          content: { text },
          status: "completed",
          model: role === "assistant" ? "gemini-3.8-flash" : null,
          created_at: new Date(start + (i * 2 + (role === "user" ? 0 : 1)) * 1000).toISOString(),
        })
        .select("id")
        .single();
      expect(error).toBeNull();
      parent = m!.id;
    }
  }
  return { email, userId: id, chatId: chat!.id as string };
}

async function send(page: Page, text: string) {
  // A long chat takes a moment to load in Safari; typing before then doesn't count, so type until
  // the Send button appears.
  await expect(async () => {
    // Clearing first makes each try count as a change.
    await page.getByLabel("Message Depeche").fill("");
    await page.getByLabel("Message Depeche").fill(text);
    await expect(page.getByRole("button", { name: "Send" })).toBeEnabled({ timeout: 1_000 });
  }).toPass({ timeout: 30_000 });
  await page.getByRole("button", { name: "Send" }).click();
  const reply = page.getByTestId("reply").last();
  await expect(reply).toHaveAttribute("aria-busy", "true");
  await expect(reply).not.toHaveAttribute("aria-busy", "true", { timeout: 30_000 });
}

test("a long chat is summarised in the background and the summary can be viewed, redone, dropped and turned off", async ({ page }) => {
  test.setTimeout(120_000);
  await familyHasGoogleKey(page);
  const db = admin();
  // About 60k tokens: due for a summary, but not so far past it that the reply waits for one.
  const { email, chatId } = await longChat("compact", 15, 2_000);

  await signInWithPassword(page, email, "member-password-123");
  await expect(page.getByRole("heading", { name: "Hi, Lena." })).toBeVisible();
  await page.goto(`/c/${chatId}`);
  await expect(page.getByTestId("summary-line")).toHaveCount(0);
  await send(page, "Where were we?");

  // The summary arrives after the reply, without a reload.
  const line = page.getByTestId("summary-line");
  await expect(line).toBeVisible({ timeout: 30_000 });
  const { data: rows } = await db.from("chat_summaries").select("id, model, cost_usd, status").eq("chat_id", chatId);
  expect(rows).toHaveLength(1);
  // Written by the cheapest model of the chat's own provider, and charged.
  expect(rows![0].model).toBe("gemini-3.5-flash-lite");
  expect(Number(rows![0].cost_usd)).toBeGreaterThan(0);
  // Every original message is still in the chat.
  await expect(page.getByText(/^Question 1\./)).toHaveCount(1);
  await expect(page.getByTestId("user-message").first()).toContainText("Planning the boat trip.");

  // Still there after a reload.
  await page.reload();
  const sheet = page.getByRole("dialog", { name: "Summary of earlier messages" });
  // A tap before the page has finished loading does nothing, so tap until the sheet opens.
  await expect(async () => {
    await page.getByTestId("summary-line").click();
    await expect(sheet).toBeVisible({ timeout: 1_000 });
  }).toPass();
  await expect(sheet.getByTestId("summary-text")).toContainText("Planning the boat trip.");
  await expect(sheet).toContainText("The secret number is 4417.");
  await expect(sheet).toContainText("Flash-Lite");

  // Redo: a fresh summary replaces it; the old one is kept, unused.
  await sheet.getByRole("button", { name: "Redo summary" }).click();
  await expect.poll(async () => (await db.from("chat_summaries").select("status").eq("chat_id", chatId).eq("status", "active")).data?.length).toBe(1);
  await expect.poll(async () => (await db.from("chat_summaries").select("id").eq("chat_id", chatId)).data?.length).toBe(2);
  await expect(sheet.getByTestId("summary-text")).toContainText("Planning the boat trip.");

  // Drop it: the line goes and the next message is read word for word again.
  await sheet.getByRole("button", { name: "Don't use this summary" }).click();
  await expect(sheet).toHaveCount(0);
  await expect(page.getByTestId("summary-line")).toHaveCount(0);
  await expect.poll(async () => (await db.from("chat_summaries").select("id").eq("chat_id", chatId).eq("status", "active")).data?.length).toBe(0);

  // The next reply makes a new one; then summaries are turned off for this chat.
  await send(page, "And now?");
  await expect(page.getByTestId("summary-line")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("summary-line").click();
  await page.getByRole("dialog", { name: "Summary of earlier messages" }).getByRole("button", { name: "Turn off for this chat" }).click();
  await expect(page.getByTestId("summary-line")).toHaveCount(0);
  await expect.poll(async () => (await db.from("chats").select("compaction").eq("id", chatId).single()).data?.compaction).toBe("off");
  await page.getByRole("button", { name: "Chat options" }).click();
  await expect(page.getByRole("menuitem", { name: "Turn on summaries" })).toBeVisible();
  await page.getByRole("menuitem", { name: "Turn on summaries" }).click();
  await expect.poll(async () => (await db.from("chats").select("compaction").eq("id", chatId).single()).data?.compaction).toBe("auto");
  await expect(page.getByTestId("summary-line")).toBeVisible();
});

test("a chat far past the limit is summarised before the reply", async ({ page }) => {
  test.setTimeout(120_000);
  await familyHasGoogleKey(page);
  const db = admin();
  // About 100k tokens, as if the app had been closed while it grew.
  const { email, chatId, userId } = await longChat("compactnow", 25, 2_000);
  await signInWithPassword(page, email, "member-password-123");
  await expect(page.getByRole("heading", { name: "Hi, Lena." })).toBeVisible();
  await page.goto(`/c/${chatId}`);
  await send(page, "Summarise first please");
  await expect(page.getByTestId("summary-line")).toBeVisible();
  const { data: rows } = await db.from("chat_summaries").select("owner_id, through_message_id").eq("chat_id", chatId);
  expect(rows?.length).toBeGreaterThanOrEqual(1);
  expect(rows![0].owner_id).toBe(userId);
  // The summary and the reply both count toward the person's spending.
  const { data: usage } = await db.from("usage_events").select("model").eq("owner_id", userId);
  expect(usage?.map((u) => u.model).sort()).toEqual(expect.arrayContaining(["gemini-3.5-flash-lite", "gemini-3.8-flash"]));
});
