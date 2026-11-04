import { expect, test, type Download, type Page } from "@playwright/test";
import { strFromU8, unzipSync } from "fflate";
import { readFile } from "node:fs/promises";
import { OWNER, admin, signInWithPassword, uniqueEmail, watchErrors } from "./helpers";

/** "Download everything" on Account, and "Download" on one chat. Replies come from the stand-in. */

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==",
  "base64",
);

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

async function bytes(download: Download) {
  return readFile((await download.path())!);
}

test("download everything gives a zip of your own chats, files and memories, and nobody else's", async ({ page }) => {
  const errors = watchErrors(page);
  const db = admin();

  // A family member with a chat whose title they share with the admin.
  const { data: owner } = await db.from("profiles").select("id, family_id").eq("is_app_owner", true).single();
  const { data: user } = await db.auth.admin.createUser({ email: uniqueEmail("member"), password: "member-password-123", email_confirm: true });
  const memberId = user.user!.id;
  const secret = `member-secret-${Date.now()}`;
  await db.from("profiles").insert({ id: memberId, family_id: owner!.family_id, display_name: "Member", share_titles: true });
  const { data: theirChat } = await db.from("chats").insert({ owner_id: memberId, title: secret }).select("id").single();
  await db.from("messages").insert({ chat_id: theirChat!.id, owner_id: memberId, role: "user", content: { text: secret } });
  await db.from("memories").insert({ owner_id: memberId, content: secret, status: "active" });
  const mine = `Remember this ${Date.now()}`;
  await db.from("memories").insert({ owner_id: owner!.id, content: mine, status: "active" });

  await signInOwner(page);
  await ensureGoogleKey(page);
  await page.goto("/");
  await page.getByRole("button", { name: /Change model/ }).click();
  const dialog = page.getByRole("dialog", { name: "Choose a model" });
  await dialog.getByRole("button", { name: /Gemini 3\.8 Flash/ }).click();
  await page.getByTestId("file-input").setInputFiles([{ name: "dot.png", mimeType: "image/png", buffer: PNG }]);
  await expect(page.getByTestId("attachment")).toHaveAttribute("data-status", "ready");
  const question = `Export me ${Date.now()}`;
  await page.getByLabel("Message Depeche").fill(question);
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page).toHaveURL(/\/c\//);
  await expect(page.getByTestId("reply").last()).toContainText("I can see dot.png.", { timeout: 15_000 });
  // The reply is saved just before the stream ends; export reads what's saved, so wait for the end.
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0, { timeout: 15_000 });

  // One chat, as Markdown, from the chat's menu.
  await page.getByRole("button", { name: "Chat options" }).click();
  const one = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: "Download" }).click();
  const chatFile = await one;
  expect(chatFile.suggestedFilename()).toMatch(/^\d{4}-\d{2}-\d{2} .+\.md$/);
  const md = (await bytes(chatFile)).toString("utf8");
  expect(md).toContain(question);
  expect(md).toContain("I can see dot.png.");
  expect(md).toContain("- dot.png");

  // Everything, from Account.
  await page.goto("/account");
  const all = page.waitForEvent("download");
  await page.getByTestId("export-everything").click();
  const zipFile = await all;
  expect(zipFile.suggestedFilename()).toMatch(/^depeche-export-\d{4}-\d{2}-\d{2}\.zip$/);
  await expect(page.getByRole("status").filter({ hasText: /^Saved depeche-export/ })).toBeVisible();

  const entries = unzipSync(new Uint8Array(await bytes(zipFile)));
  const text = (suffix: string) => strFromU8(entries[Object.keys(entries).find((k) => k.endsWith(suffix))!]);
  const names = Object.keys(entries);
  expect(names.every((n) => n.startsWith("depeche-export-"))).toBe(true);
  expect(names.some((n) => /\/files\/dot.*\.png$/.test(n))).toBe(true);
  expect(text("/chats.json")).toContain(question);
  expect(text("/memories.md")).toContain(mine);
  expect(JSON.parse(text("/profile.json")).email).toBe(OWNER.email);
  expect(text("/README.txt")).toContain("only yours");
  expect(text("/usage.csv").split("\n")[0]).toBe("created_at,provider,model,input_tokens,output_tokens,cost_usd,message_id");
  const chatMd = names.filter((n) => n.includes("/chats/")).map((n) => strFromU8(entries[n])).find((t) => t.includes(question))!;
  expect(chatMd).toMatch(/\[dot.*\.png\]\(\.\.\/files\/dot.*\.png\)/);

  // The member's chat, memory and words are nowhere in the admin's export.
  for (const n of names) expect(strFromU8(entries[n]), n).not.toContain(secret);
  expect(errors.filter((e) => !/_rsc=.*access control checks/.test(e))).toEqual([]);
});
