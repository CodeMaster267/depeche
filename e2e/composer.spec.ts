import { expect, test, type Page } from "@playwright/test";
import { OWNER, admin, noSidewaysScroll, signInWithPassword, uniqueEmail, watchErrors } from "./helpers";

/**
 * The message box's extras: saved prompts with blanks, "think harder", lining up the next message
 * while a reply is written, and drafts kept per chat.
 */

/** A person of their own (so their prompts and chats don't mix with other tests), on Gemini 3.8 Flash. */
async function newPerson(page: Page, name: string) {
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

  const db = admin();
  const email = uniqueEmail("compose");
  const { data: user } = await db.auth.admin.createUser({ email, password: "member-password-123", email_confirm: true });
  const { data: owner } = await db.from("profiles").select("family_id").eq("is_app_owner", true).single();
  await db.from("profiles").insert({ id: user.user!.id, family_id: owner!.family_id, display_name: name });

  await signInWithPassword(page, email, "member-password-123");
  await expect(page.getByRole("heading", { name: `Hi, ${name}.` })).toBeVisible();
  await page.getByRole("button", { name: /Change model/ }).click();
  const dialog = page.getByRole("dialog", { name: "Choose a model" });
  await dialog.getByRole("button", { name: /Gemini 3\.8 Flash/ }).click();
  await expect(dialog).toHaveCount(0);
}

const box = (page: Page) => page.getByLabel("Message Depeche");

test("a saved prompt with blanks is filled in, put in the message, edited and deleted", async ({ page }) => {
  const errors = watchErrors(page);
  await newPerson(page, "Pia");
  await box(page).fill("Say hello nicely");
  await page.getByRole("button", { name: "Saved prompts" }).click();
  const sheet = page.getByRole("dialog", { name: "Saved prompts" });
  await expect(sheet.getByText(/double curly brackets/)).toBeVisible();
  await noSidewaysScroll(page);

  // What was typed can be saved as it is.
  await sheet.getByRole("button", { name: "Save what I typed" }).click();
  await expect(page.getByLabel("Prompt", { exact: true })).toHaveValue("Say hello nicely");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(sheet.getByRole("button", { name: /^Say hello nicely/ })).toBeVisible();

  // A new one with blanks.
  await sheet.getByRole("button", { name: "New prompt" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Translate");
  await page.getByLabel("Prompt", { exact: true }).fill("Translate {{text}} into {{language}}.");
  await expect(page.getByText("You'll be asked for: text, language.")).toBeVisible();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await sheet.getByRole("button", { name: /^Translate/ }).click();
  await page.getByRole("dialog", { name: "Translate" }).getByLabel("text", { exact: true }).fill("good morning");
  await page.getByRole("dialog", { name: "Translate" }).getByLabel("language", { exact: true }).fill("Urdu");
  await page.getByRole("button", { name: "Put in message" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(box(page)).toHaveValue("Say hello nicely\n\nTranslate good morning into Urdu.");

  // Kept after a reload, then edited and deleted.
  await page.reload();
  await page.getByRole("button", { name: "Saved prompts" }).click();
  await sheet.getByRole("button", { name: "Edit Translate" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Translate it");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(sheet.getByRole("button", { name: /^Translate it/ })).toBeVisible();
  await sheet.getByRole("button", { name: "Edit Translate it" }).click();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(sheet.getByRole("button", { name: /^Translate/ })).toHaveCount(0);
  await expect(sheet.getByRole("button", { name: /^Say hello nicely/ })).toBeVisible();
  // Safari reports a page prefetch cut short by the reload above as an error; that one is harmless.
  expect(errors.filter((e) => !/_rsc=.* due to access control checks/.test(e))).toEqual([]);
});

test("think harder reaches the model and is shown on the reply", async ({ page }) => {
  await newPerson(page, "Theo");
  const think = page.getByRole("button", { name: "Think harder" });
  await expect(think).toHaveAttribute("aria-pressed", "false");
  await think.click();
  await expect(think).toHaveAttribute("aria-pressed", "true");
  await box(page).fill("Is this hard?");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const reply = page.getByTestId("reply").last();
  await expect(reply).not.toHaveAttribute("aria-busy", "true", { timeout: 15_000 });
  await expect(reply).toContainText("I thought harder about this.");
  await expect(reply).toContainText("thought harder");

  // Off again: the next reply is an ordinary one.
  await think.click();
  await box(page).fill("And this?");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const next = page.getByTestId("reply").nth(1);
  await expect(next).not.toHaveAttribute("aria-busy", "true", { timeout: 15_000 });
  await expect(next).not.toContainText("thought harder");
});

test("messages written while a reply streams are sent after it, in order", async ({ page }) => {
  await newPerson(page, "Quinn");
  await box(page).fill("Tell me slowly");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByTestId("reply").first()).toHaveAttribute("aria-busy", "true");

  await box(page).fill("Second question");
  await page.getByRole("button", { name: "Send after this reply" }).click();
  await box(page).fill("Third question");
  await page.getByRole("button", { name: "Send after this reply" }).click();
  await expect(page.getByTestId("queued")).toHaveCount(2);
  await expect(box(page)).toHaveValue("");
  // One can be taken back off the queue.
  await page.getByTestId("queued").last().getByRole("button", { name: "Remove from queue" }).click();
  await expect(page.getByTestId("queued")).toHaveCount(1);

  await expect(page.getByTestId("user-message")).toHaveText(["Tell me slowly", "Second question"], { timeout: 30_000 });
  await expect(page.getByTestId("queued")).toHaveCount(0);
  await expect(page.getByTestId("reply")).toHaveCount(2);
  await expect(page.getByTestId("reply").last()).not.toHaveAttribute("aria-busy", "true", { timeout: 30_000 });

  // After a stop, queued messages wait until the person sends them.
  await box(page).fill("Again slowly please");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await box(page).fill("Fourth question");
  await page.getByRole("button", { name: "Send after this reply" }).click();
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(page.getByText("Stopped.")).toBeVisible();
  await expect(page.getByTestId("queued")).toHaveCount(1);
  await page.getByRole("button", { name: "Send now" }).click();
  await expect(page.getByTestId("user-message").last()).toHaveText("Fourth question");
});

test("an unsent draft is kept for each chat", async ({ page }) => {
  await newPerson(page, "Dara");
  // A new chat's draft survives a reload.
  await box(page).fill("Half a thought");
  await page.reload();
  await expect(box(page)).toHaveValue("Half a thought");

  // Sending clears it; a chat keeps its own draft.
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page).toHaveURL(/\/c\//);
  const chatUrl = page.url();
  await expect(page.getByTestId("reply").last()).not.toHaveAttribute("aria-busy", "true", { timeout: 15_000 });
  await box(page).fill("Something for this chat");
  await page.goto("/");
  await expect(box(page)).toHaveValue("");
  await page.goto(chatUrl);
  await expect(box(page)).toHaveValue("Something for this chat");
});
