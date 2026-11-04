import { createClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";
import { OWNER, SUPABASE_URL, admin, noSidewaysScroll, signInWithPassword, uniqueEmail, watchErrors } from "./helpers";

/**
 * Making and editing pictures. The stand-in draws stripes (turned the other way when it edits),
 * so these tests never call a real provider or spend money.
 */

async function signInOwner(page: Page) {
  await signInWithPassword(page, OWNER.email, OWNER.password);
  await expect(page.getByRole("heading", { name: "Hi, Hasan." })).toBeVisible();
}

async function ensureGoogleKey(page: Page) {
  await page.goto("/family");
  const row = page.getByTestId("provider-google");
  await expect(row.getByText(/Not added|ends in/)).toBeVisible();
  if (await row.getByText("Not added").isVisible()) {
    await row.getByLabel("Google (Gemini) API key").fill("test-google-key-1234567890abcd");
    await row.getByRole("button", { name: "Save key" }).click();
    await expect(row.getByText(/ends in/)).toBeVisible();
  }
}

async function pick(page: Page, name: RegExp) {
  await page.getByRole("button", { name: /Change model/ }).click();
  const dialog = page.getByRole("dialog", { name: "Choose a model" });
  await dialog.getByRole("button", { name }).click();
  await expect(dialog).toHaveCount(0);
}

/** Waits for the newest reply to finish and its picture to load. */
async function newestPicture(page: Page) {
  const reply = page.getByTestId("reply").last();
  await expect(reply).not.toHaveAttribute("aria-busy", "true", { timeout: 20_000 });
  const img = reply.getByTestId("picture");
  await expect(img).toBeVisible();
  await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  return reply;
}

test("a picture is made, then edited by the next message, and only its owner can open it", async ({ page }, info) => {
  const errors = watchErrors(page);
  await signInOwner(page);
  await ensureGoogleKey(page);
  await page.goto("/");

  // Picture models have their own heading in the picker.
  await page.getByRole("button", { name: /Change model/ }).click();
  const dialog = page.getByRole("dialog", { name: "Choose a model" });
  await expect(dialog.getByRole("heading", { name: "Make pictures" })).toBeVisible();
  await dialog.getByRole("button", { name: /Nano Banana 2\.1/ }).click();
  await expect(page.getByRole("button", { name: /Model: Nano Banana 2\.1/ })).toBeVisible();

  const box = page.getByLabel("Message Depeche");
  await expect(box).toHaveAttribute("placeholder", "Describe a picture to make");
  // Web search doesn't apply to pictures.
  await expect(page.getByRole("button", { name: "Search the web" })).toBeDisabled();

  const ask = `a striped flag, slowly ${Date.now()}`;
  await box.fill(ask);
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByTestId("making-picture")).toContainText("Making the picture");
  const first = await newestPicture(page);
  await expect(first.getByRole("button", { name: "Edit" })).toBeVisible();
  await expect(first).toContainText("Nano Banana 2.1");

  // The next message edits that picture, unless × is tapped.
  const chip = page.getByTestId("editing-chip");
  await expect(chip).toContainText("Editing this picture");
  await expect(box).toHaveAttribute("placeholder", "Describe what to change");
  if (process.env.SHOTS) await page.screenshot({ path: `/mnt/project-files/depeche/screens/pictures/${info.project.name}-made.png` });
  await box.fill("turn the stripes sideways");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByTestId("making-picture")).toContainText("Editing the picture");
  await newestPicture(page);
  // The edited picture is shown on the message that asked for the change.
  await expect(page.getByTestId("message-files").last().getByRole("img")).toBeVisible();

  const db = admin();
  const chatId = new URL(page.url()).pathname.split("/c/")[1];
  const { data: rows } = await db
    .from("messages")
    .select("id, role, content, chat_id, created_at")
    .eq("chat_id", chatId)
    .order("created_at", { ascending: false })
    .limit(4)
    .returns<{ id: string; role: string; content: { text?: string; files?: { path: string; mime: string }[]; cost?: number } }[]>();
  const [edited, change, made, asked] = rows!;
  expect(asked.content.text).toBe(ask);
  expect(made.role).toBe("assistant");
  expect(made.content.files?.[0].mime).toBe("image/png");
  expect(change.content.files?.[0].path).toBe(made.content.files?.[0].path);
  expect(edited.content.files?.[0].path).not.toBe(made.content.files?.[0].path);
  expect(edited.content.cost).toBeGreaterThan(0);
  const { data: usage } = await db.from("usage_events").select("cost_usd, model").eq("message_id", edited.id).single();
  expect(usage?.model).toBe("gemini-nano-banana-2.1");
  expect(Number(usage?.cost_usd)).toBeGreaterThan(0);

  // × makes the next message a new picture instead.
  await page.getByRole("button", { name: "Make a new picture instead" }).click();
  await expect(chip).toHaveCount(0);
  await expect(box).toHaveAttribute("placeholder", "Describe a picture to make");

  // Edit on an older picture puts it in the tray.
  await page.getByTestId("reply").first().getByRole("button", { name: "Edit" }).click();
  await expect(page.getByTestId("attachment")).toHaveAttribute("data-status", "ready");
  // Taking it out again never deletes the stored picture.
  await page.getByRole("button", { name: /^Remove / }).click();
  await page.reload();
  await expect(page.getByTestId("picture")).toHaveCount(2);

  // Download saves the file (on phones it opens the share sheet instead).
  if (!info.project.name.includes("iphone") && !info.project.name.includes("android")) {
    const download = page.waitForEvent("download");
    await page.getByTestId("reply").last().getByRole("button", { name: /^Download / }).click();
    expect((await download).suggestedFilename()).toMatch(/\.png$/);
  }
  await noSidewaysScroll(page);
  if (process.env.SHOTS) await page.screenshot({ path: `/mnt/project-files/depeche/screens/pictures/${info.project.name}-edited.png` });
  expect(errors).toEqual([]);

  // Someone else in the family can't read the picture, even by asking storage directly.
  const email = uniqueEmail("peek");
  const { data: user } = await db.auth.admin.createUser({ email, password: "member-password-123", email_confirm: true });
  const { data: owner } = await db.from("profiles").select("family_id").eq("is_app_owner", true).single();
  await db.from("profiles").insert({ id: user.user!.id, family_id: owner!.family_id, display_name: "Peek" });
  const member = createClient(SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false } });
  await member.auth.signInWithPassword({ email, password: "member-password-123" });
  const { data: stolen } = await member.storage.from("uploads").download(edited.content.files![0].path);
  expect(stolen).toBeNull();
});

test("a turned-down picture says why, and chat models know a picture was made", async ({ page }) => {
  await signInOwner(page);
  await ensureGoogleKey(page);
  await page.goto("/");
  await pick(page, /Nano Banana Pro/);
  await page.getByLabel("Message Depeche").fill("please refuse this");
  await page.getByRole("button", { name: "Send" }).click();
  const reply = page.getByTestId("reply").last();
  await expect(reply.getByRole("alert")).toContainText("safety check turned this picture down", { timeout: 20_000 });

  // A picture model needs words: a picture alone can't be sent to it.
  await page.getByLabel("Message Depeche").fill("");
  await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();

  await page.getByLabel("Message Depeche").fill("a lighthouse");
  await page.getByRole("button", { name: "Send" }).click();
  await newestPicture(page);

  // Switching to a chat model: the conversation carries on, and the box is for messages again.
  await pick(page, /Gemini 3\.8 Flash/);
  await expect(page.getByTestId("editing-chip")).toHaveCount(0);
  await expect(page.getByLabel("Message Depeche")).toHaveAttribute("placeholder", "Message Depeche");
  await page.getByLabel("Message Depeche").fill("describe it");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByTestId("reply").last()).not.toHaveAttribute("aria-busy", "true", { timeout: 15_000 });

  // Picking a picture model never makes it the model new chats start with.
  const { data: me } = await admin().from("profiles").select("last_model").eq("is_app_owner", true).single();
  expect(me?.last_model ?? "").not.toMatch(/image|banana/);
});
