import { readFile } from "node:fs/promises";
import { strToU8, zipSync } from "fflate";
import { expect, test, type Page } from "@playwright/test";
import { OWNER, signInWithPassword, watchErrors } from "./helpers";
import { markdownToDocx, tableToXlsx } from "../lib/docs/write";
import { documentText } from "../lib/docs/read";
import { DOCX, XLSX } from "../lib/chat/files";

/**
 * Reading Word, Excel and PowerPoint files, and downloading files a model makes. Replies come
 * from the stand-in model: "quote" makes it repeat the start of each file it was given, and
 * "make files" makes it write a Word document, a spreadsheet and a CSV file.
 */

test.setTimeout(60_000);

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

async function newChat(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: /Change model/ }).click();
  const dialog = page.getByRole("dialog", { name: "Choose a model" });
  await dialog.getByRole("button", { name: /Gemini 3\.8 Flash/ }).click();
  await expect(dialog).toHaveCount(0);
}

const slides = zipSync({
  "ppt/slides/slide1.xml": strToU8("<p:sld><a:p><a:r><a:t>Quarterly plan</a:t></a:r></a:p></p:sld>"),
});

test("Word, Excel and PowerPoint files are read and passed to the model", async ({ page }) => {
  const errors = watchErrors(page);
  await signInOwner(page);
  await ensureGoogleKey(page);
  await newChat(page);

  await page.getByTestId("file-input").setInputFiles([
    { name: "Letter.docx", mimeType: DOCX, buffer: Buffer.from(markdownToDocx("# Dear Amir\n\nThe **garden** party is on Sunday.")) },
    { name: "Budget.xlsx", mimeType: XLSX, buffer: Buffer.from(tableToXlsx("Item,Cost\nCake,12")) },
    // Some phones give no type at all; the ending is enough.
    { name: "Deck.pptx", mimeType: "", buffer: Buffer.from(slides) },
    { name: "Old.doc", mimeType: "application/msword", buffer: Buffer.from("old") },
  ]);
  const tray = page.getByTestId("attachment");
  await expect(tray).toHaveCount(4);
  for (const i of [0, 1, 2]) await expect(tray.nth(i)).toHaveAttribute("data-status", "ready");
  await expect(tray.nth(3)).toHaveAttribute("data-status", "error");
  await expect(tray.nth(3)).toContainText("Save it as .docx");
  await page.getByRole("button", { name: "Remove Old.doc" }).click();

  await page.getByLabel("Message Depeche").fill(`Please quote these ${Date.now()}`);
  await page.getByRole("button", { name: "Send" }).click();
  const reply = page.getByTestId("reply").last();
  await expect(reply).not.toHaveAttribute("aria-busy", "true", { timeout: 15_000 });
  await expect(reply).toContainText("Letter.docx says: # Dear Amir The garden party is on Sunday.");
  await expect(reply).toContainText("Budget.xlsx says: ## Sheet: Sheet1 Item,Cost Cake,12");
  await expect(reply).toContainText("Deck.pptx says: ## Slide 1 Quarterly plan");
  expect(errors.filter((e) => !/_rsc=.*access control checks/.test(e))).toEqual([]);
});

test("files the model makes can be downloaded, also in other formats", async ({ page }) => {
  const errors = watchErrors(page);
  await signInOwner(page);
  await ensureGoogleKey(page);
  await newChat(page);
  await page.getByLabel("Message Depeche").fill(`Please make files ${Date.now()}`);
  await page.getByRole("button", { name: "Send" }).click();

  const reply = page.getByTestId("reply").last();
  await expect(reply).not.toHaveAttribute("aria-busy", "true", { timeout: 15_000 });
  const cards = reply.getByTestId("file-card");
  await expect(cards).toHaveCount(3);
  const word = cards.nth(0);
  await expect(word).toHaveAttribute("data-ready", "true");
  await expect(word).toContainText("Trip-plan.docx");
  await expect(word).toContainText(/Word document · \d+ KB/);
  // The file's contents are in the card, not shown as code.
  await expect(reply.locator(".md-code").filter({ hasText: "file:" })).toHaveCount(0);

  const [docx] = await Promise.all([page.waitForEvent("download"), word.getByRole("button", { name: "Download Trip-plan.docx" }).click()]);
  expect(docx.suggestedFilename()).toBe("Trip-plan.docx");
  const text = await documentText(DOCX, new Uint8Array(await readFile((await docx.path())!)));
  expect(text).toContain("# Trip plan");
  expect(text).toContain("A short trip to Lisbon. Café stop on day one.");
  expect(text).toContain("| Mon | Museum |");
  expect(text).toContain("pack light");

  const [pdf] = await Promise.all([page.waitForEvent("download"), word.getByRole("button", { name: "As PDF" }).click()]);
  expect(pdf.suggestedFilename()).toBe("Trip-plan.pdf");
  expect((await readFile((await pdf.path())!)).subarray(0, 5).toString()).toBe("%PDF-");

  const sheet = cards.nth(1);
  await expect(sheet).toContainText("Excel spreadsheet");
  const [xlsx] = await Promise.all([page.waitForEvent("download"), sheet.getByRole("button", { name: "Download Budget.xlsx" }).click()]);
  expect(await documentText(XLSX, new Uint8Array(await readFile((await xlsx.path())!)))).toContain("Hotel,310");

  await word.getByRole("button", { name: "Show contents" }).click();
  await expect(word.locator(".md-file-source")).toContainText("A **short** trip to Lisbon.");

  // Still there after a reload.
  await page.reload();
  await expect(page.getByTestId("reply").last().getByTestId("file-card")).toHaveCount(3);
  expect(errors.filter((e) => !/_rsc=.*access control checks/.test(e))).toEqual([]);
});
