import { expect, test, type Browser, type Page } from "@playwright/test";
import { OWNER, admin, noSidewaysScroll, signInWithPassword, uniqueEmail, watchErrors } from "./helpers";

/**
 * Saved assistants: made by one person, optionally shared with their family. The stand-in AI
 * repeats the assistant's name, instructions and files when a message says "assistant".
 */

async function ensureGoogleKey(browser: Browser) {
  const page = await browser.newPage();
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
  await page.close();
}

/** A new member of Hasan's family, signed in on `page`. */
async function member(page: Page, name: string) {
  const db = admin();
  const email = uniqueEmail("assistants");
  const { data: user } = await db.auth.admin.createUser({ email, password: "member-password-123", email_confirm: true });
  const id = user.user!.id;
  const { data: owner } = await db.from("profiles").select("family_id").eq("is_app_owner", true).single();
  await db.from("profiles").insert({ id, family_id: owner!.family_id, display_name: name });
  await signInWithPassword(page, email, "member-password-123");
  await expect(page.getByRole("heading", { name: `Hi, ${name}.` })).toBeVisible();
  return { db, id };
}

async function waitForReply(page: Page, text: string) {
  await expect(page.getByTestId("reply").last()).toContainText(text, { timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Stop" })).toHaveCount(0, { timeout: 30_000 });
}

test("make an assistant, share it with the family, and chat with it", async ({ page, browser }) => {
  test.setTimeout(120_000);
  await ensureGoogleKey(browser);
  const errors = watchErrors(page);
  const { db, id } = await member(page, "Rumi");
  const tag = Math.random().toString(36).slice(2, 7);
  const name = `Homework helper ${tag}`;

  await page.goto("/assistants");
  await page.getByRole("link", { name: "New assistant" }).click();
  await expect(page.getByRole("heading", { name: "New assistant" })).toBeVisible();
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByLabel("What it's for", { exact: true }).fill("Helps with school work");
  await page.getByLabel("Instructions", { exact: true }).fill("Guide step by step.");
  await page.getByLabel("Model", { exact: true }).selectOption("gemini-3.8-flash");
  await page.getByLabel("Share with my family").check();
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page).toHaveURL(/\/assistants\/[0-9a-f-]{36}$/);
  const assistantId = page.url().split("/assistants/")[1];
  await expect(page.getByRole("heading", { name: "Edit assistant" })).toBeVisible();
  await noSidewaysScroll(page);
  await page.getByTestId("assistant-file-input").setInputFiles([{ name: "rules.txt", mimeType: "text/plain", buffer: Buffer.from("Show working.") }]);
  await expect(page.getByTestId("assistant-file")).toHaveCount(1);
  expect((await db.from("assistants").select("owner_id, shared, model").eq("id", assistantId).single()).data).toEqual({
    owner_id: id,
    shared: true,
    model: "gemini-3.8-flash",
  });

  // Chat with it: the model gets its instructions and files.
  await page.getByRole("link", { name: `Chat with ${name}` }).click();
  await expect(page.getByTestId("assistant-start").getByRole("heading", { name })).toBeVisible();
  await expect(page.getByLabel("Message Depeche")).toHaveAttribute("placeholder", `Message ${name}`);
  await page.getByLabel("Message Depeche").fill("what does the assistant say");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page).toHaveURL(/\/c\/[0-9a-f-]{36}$/);
  await waitForReply(page, `Assistant: ${name}. Assistant instructions: Guide step by step.. Assistant files: rules.txt.`);
  await expect(page.getByRole("banner").getByRole("link", { name: `Assistant: ${name}` })).toBeVisible();
  const chatId = page.url().split("/c/")[1];
  expect((await db.from("chats").select("assistant_id").eq("id", chatId).single()).data?.assistant_id).toBe(assistantId);

  // Someone else in the family finds it on their home screen and can chat with it, but not change it.
  const other = await browser.newPage();
  await member(other, "Sami");
  await other.getByRole("list", { name: "Start with an assistant" }).getByRole("link", { name }).click();
  await expect(other.getByTestId("assistant-start")).toContainText("Assistant shared by your family");
  await other.getByLabel("Message Depeche").fill("assistant, are you there");
  await other.getByRole("button", { name: "Send" }).click();
  await waitForReply(other, "Assistant instructions: Guide step by step.");
  await other.goto(`/assistants/${assistantId}`);
  await expect(other.getByTestId("assistant-instructions")).toHaveText("Guide step by step.");
  await expect(other.getByRole("button", { name: "Save" })).toHaveCount(0);
  // Rumi can't read Sami's chat with it.
  expect((await db.from("chats").select("owner_id").eq("assistant_id", assistantId)).data?.length).toBe(2);

  // Once Rumi stops sharing it, Sami no longer sees it, and their chat carries on without it.
  await page.goto(`/assistants/${assistantId}`);
  await page.getByLabel("Share with my family").uncheck();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Saved.")).toBeVisible();
  await other.goto(`/assistants/${assistantId}`);
  await expect(other.getByText(/could not be found|404/i).first()).toBeVisible();
  await other.goto("/");
  await expect(other.getByRole("link", { name })).toHaveCount(0);
  const sent = await other.request.post("/api/chat", {
    data: { assistantId, text: "assistant leak?", model: "gemini-3.8-flash", clientRequestId: crypto.randomUUID() },
  });
  expect(sent.status()).toBe(404);
  await other.close();
  expect(errors).toEqual([]);
});
