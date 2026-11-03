import { createClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";
import { OWNER, SUPABASE_URL, admin, signInWithPassword, uniqueEmail, watchErrors } from "./helpers";

/** Attaching photos and files. Replies come from the stand-in, which names the files it was sent. */

// A 2×2 PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==",
  "base64",
);

async function signInOwner(page: Page) {
  await signInWithPassword(page, OWNER.email, OWNER.password);
  await expect(page.getByRole("heading", { name: "Hi, Hasan." })).toBeVisible();
}

/** Opens a new chat with Gemini picked; the picker opening also shows the page is ready. */
async function newChat(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: /Change model/ }).click();
  const dialog = page.getByRole("dialog", { name: "Choose a model" });
  await dialog.getByRole("button", { name: /Gemini 3\.8 Flash/ }).click();
  await expect(dialog).toHaveCount(0);
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

test("a photo and a text file are sent with a message, and only their owner can open them", async ({ page }) => {
  const errors = watchErrors(page);
  await signInOwner(page);
  await ensureGoogleKey(page);
  await newChat(page);

  await page.getByTestId("file-input").setInputFiles([
    { name: "dot.png", mimeType: "image/png", buffer: PNG },
    { name: "notes.md", mimeType: "text/markdown", buffer: Buffer.from("# Shopping\n- eggs\n- milk") },
  ]);
  const tray = page.getByTestId("attachment");
  await expect(tray).toHaveCount(2);
  await expect(tray.nth(0)).toHaveAttribute("data-status", "ready");
  await expect(tray.nth(1)).toHaveAttribute("data-status", "ready");

  const question = `What's in these? ${Date.now()}`;
  await page.getByLabel("Message Depeche").fill(question);
  await page.getByRole("button", { name: "Send" }).click();
  await expect(tray).toHaveCount(0);

  const reply = page.getByTestId("reply").last();
  await expect(reply).not.toHaveAttribute("aria-busy", "true", { timeout: 15_000 });
  await expect(reply).toContainText("I can see dot.png, notes.md.");

  // After a reload the photo shows from private storage, and the text file is listed.
  await page.reload();
  const files = page.getByTestId("message-files").last();
  await expect(files.getByRole("img", { name: "dot.png" })).toBeVisible();
  await expect(files.getByText("notes.md")).toBeVisible();
  expect(errors.filter((e) => !/_rsc=.*access control checks/.test(e))).toEqual([]);

  // Someone else in the family can't read the file, even by asking storage directly.
  const db = admin();
  const { data: msg } = await db
    .from("messages")
    .select("content")
    .eq("role", "user")
    .contains("content", { text: question })
    .single<{ content: { files: { path: string }[] } }>();
  const path = msg!.content.files[0].path;
  const email = uniqueEmail("peek");
  const { data: user } = await db.auth.admin.createUser({ email, password: "member-password-123", email_confirm: true });
  const { data: owner } = await db.from("profiles").select("family_id").eq("is_app_owner", true).single();
  await db.from("profiles").insert({ id: user.user!.id, family_id: owner!.family_id, display_name: "Peek" });
  const member = createClient(SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false } });
  await member.auth.signInWithPassword({ email, password: "member-password-123" });
  const { data: stolen } = await member.storage.from("uploads").download(path);
  expect(stolen).toBeNull();
  const { error: planted } = await member.storage.from("uploads").upload(`${path.split("/")[0]}/x/planted.png`, PNG, { contentType: "image/png" });
  expect(planted).not.toBeNull();
});

test("a file can be sent on its own, and a kind that can't be sent is refused", async ({ page }) => {
  await signInOwner(page);
  await ensureGoogleKey(page);
  await newChat(page);
  await page.getByTestId("file-input").setInputFiles([
    { name: "song.mp3", mimeType: "audio/mpeg", buffer: Buffer.from("not really") },
  ]);
  await expect(page.getByTestId("attachment")).toHaveAttribute("data-status", "error");
  await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();
  await page.getByRole("button", { name: "Remove song.mp3" }).click();

  await page.getByTestId("file-input").setInputFiles([{ name: "photo.png", mimeType: "image/png", buffer: PNG }]);
  await expect(page.getByTestId("attachment")).toHaveAttribute("data-status", "ready");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page).toHaveURL(/\/c\//);
  await expect(page.getByTestId("reply").last()).toContainText("I can see photo.png.", { timeout: 15_000 });
  await expect(page.getByRole("heading", { name: "photo.png" })).toBeVisible();
});
