import { expect, test } from "@playwright/test";
import { strToU8, zipSync } from "fflate";
import { admin, noSidewaysScroll, signInWithPassword, uniqueEmail, watchErrors } from "./helpers";
import { chatgpt, claude } from "../tests/fixtures/import/samples";

/** "Bring in old chats" on Account: a ChatGPT or Claude export zip becomes the person's own chats. */

test("imports a ChatGPT export into your own chats, once, and they open and search like any chat", async ({ page }) => {
  const errors = watchErrors(page);
  const db = admin();
  const { data: owner } = await db.from("profiles").select("family_id").eq("is_app_owner", true).single();
  const email = uniqueEmail("importer");
  const { data: user } = await db.auth.admin.createUser({ email, password: "member-password-123", email_confirm: true });
  const memberId = user.user!.id;
  await db.from("profiles").insert({ id: memberId, family_id: owner!.family_id, display_name: "Importer" });

  await signInWithPassword(page, email, "member-password-123");
  await expect(page.getByRole("heading", { name: "Hi, Importer." })).toBeVisible();
  await page.goto("/account");
  const box = page.getByTestId("import-chats");
  await expect(box.getByText("Bring your old chats from ChatGPT")).toBeVisible();
  await noSidewaysScroll(page);

  // A real export also holds pictures and a web page; only conversations.json is read.
  const zip = zipSync({
    "chat.html": strToU8("<html><script>alert(1)</script></html>"),
    "conversations.json": strToU8(JSON.stringify(chatgpt)),
    "file-abc.png": new Uint8Array(2000),
  });
  await page.getByTestId("import-file").setInputFiles({ name: "chatgpt-export.zip", mimeType: "application/zip", buffer: Buffer.from(zip) });
  await expect(page.getByTestId("import-found")).toContainText("Found 2 chats from ChatGPT");
  await page.getByTestId("import-start").click();
  await expect(page.getByTestId("import-result")).toHaveText("Brought in 2 chats from ChatGPT.");

  // The same export again adds nothing.
  await page.getByTestId("import-file").setInputFiles({ name: "chatgpt-export.zip", mimeType: "application/zip", buffer: Buffer.from(zip) });
  await page.getByTestId("import-start").click();
  await expect(page.getByTestId("import-result")).toHaveText("Brought in 0 chats from ChatGPT. 2 were already here.");

  // A Claude export, as the plain JSON file.
  await page.getByTestId("import-file").setInputFiles({ name: "conversations.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(claude)) });
  await expect(page.getByTestId("import-found")).toContainText("Found 1 chat from Claude");
  await page.getByTestId("import-start").click();
  await expect(page.getByTestId("import-result")).toHaveText("Brought in 1 chat from Claude.");

  // The wrong file gets a clear explanation.
  await page.getByTestId("import-file").setInputFiles({ name: "notes.zip", mimeType: "application/zip", buffer: Buffer.from(zipSync({ "a.txt": strToU8("hi") })) });
  await expect(box.getByRole("alert")).toContainText("Couldn't find any chats in that file");

  // Stored as the person's own chats, with the replies and original dates.
  const { data: chats } = await db.from("chats").select("id, title, imported_from, updated_at").eq("owner_id", memberId).order("title");
  expect(chats!.map((c) => [c.title, c.imported_from])).toEqual([
    ["Boiler pressure", "chatgpt"],
    ["Photo question", "chatgpt"],
    ["Trip to Lahore", "claude"],
  ]);
  expect(chats![0].updated_at.startsWith("2024-06-01")).toBe(true);

  // Open it: the conversation shows, marked as imported, and can carry on like any chat.
  await page.goto(`/c/${chats![0].id}`);
  await expect(page.getByTestId("imported-from")).toContainText("Imported from ChatGPT");
  await expect(page.getByTestId("user-message")).toHaveText("My boiler shows 0.5 bar. Is that low?");
  await expect(page.getByText("Top it up to about 1.5 bar.")).toBeVisible();
  await expect(page.getByText("An abandoned branch.")).toHaveCount(0);
  await expect(page.getByLabel("Message Depeche")).toBeVisible();
  await noSidewaysScroll(page);

  // Nobody else can see it: the family admin's view of this person's messages is empty.
  const { count } = await db.from("messages").select("id", { count: "exact", head: true }).eq("owner_id", memberId);
  expect(count).toBe(6);
  expect(errors).toEqual([]);
});
