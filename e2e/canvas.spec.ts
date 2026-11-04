import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { OWNER, signInWithPassword, watchErrors } from "./helpers";
import { documentText } from "../lib/docs/read";
import { DOCX } from "../lib/chat/files";

/**
 * Canvas: a document beside the chat (a sheet on phones) that the person and the AI both edit.
 * Replies come from the stand-in model: "canvas" makes it write a speech in a canvas, or, when a
 * canvas exists, rewrite it keeping what's there (so the person's edits must reach it).
 */

test.setTimeout(90_000);

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

async function send(page: Page, text: string) {
  await page.getByLabel("Message Depeche").fill(text);
  await page.getByRole("button", { name: "Send" }).click();
  const reply = page.getByTestId("reply").last();
  await expect(reply).not.toHaveAttribute("aria-busy", "true", { timeout: 20_000 });
  return reply;
}

test("the AI writes a canvas, the person edits it, and the AI works from their edit", async ({ page }) => {
  const errors = watchErrors(page);
  await signInWithPassword(page, OWNER.email, OWNER.password);
  await expect(page.getByRole("heading", { name: "Hi, Hasan." })).toBeVisible();
  await ensureGoogleKey(page);
  await page.goto("/");
  await page.getByRole("button", { name: /Change model/ }).click();
  await page.getByRole("dialog", { name: "Choose a model" }).getByRole("button", { name: /Gemini 3\.8 Flash/ }).click();

  // The AI's draft opens in the canvas; the reply only carries a card for it.
  const reply = await send(page, `Write my wedding speech in the canvas ${Date.now()}`);
  await expect(reply.getByTestId("canvas-card")).toContainText("Wedding speech");
  await expect(reply.locator(".md-code")).toHaveCount(0);
  const canvas = page.getByTestId("canvas");
  await expect(canvas).toBeVisible();
  await expect(canvas.getByRole("heading", { name: "Wedding speech" })).toBeVisible();
  await expect(canvas.getByTestId("canvas-text")).toContainText("Thank you all for coming tonight.");
  await expect(canvas.getByTestId("canvas-status")).toHaveText("Version 1 of 1 · written by the AI");

  // The person edits it.
  await canvas.getByRole("button", { name: "Edit", exact: true }).click();
  const editor = canvas.getByLabel("Edit Wedding speech");
  await editor.fill("# A toast\n\nThank you all for coming tonight.\n\nMy own line about Amir.");
  await canvas.getByRole("button", { name: "Done" }).click();
  await expect(canvas.getByTestId("canvas-status")).toHaveText("Version 2 of 2 · edited by you");
  await expect(canvas.getByTestId("canvas-text")).toContainText("My own line about Amir.");

  // On phones the sheet covers the chat: close it to write the next message.
  if ((page.viewportSize()?.width ?? 0) < 1024) {
    await canvas.getByRole("button", { name: "Close canvas" }).click();
    await expect(canvas).toHaveCount(0);
  }
  const second = await send(page, "Now polish the canvas please");
  await expect(second.getByTestId("canvas-card")).toBeVisible();
  await expect(canvas).toBeVisible();
  await expect(canvas.getByTestId("canvas-status")).toHaveText("Version 3 of 3 · written by the AI");
  // The AI's rewrite kept the person's edit, so it saw it.
  await expect(canvas.getByTestId("canvas-text")).toContainText("My own line about Amir.");
  await expect(canvas.getByTestId("canvas-text")).toContainText("Revised by the AI.");

  // Older versions can be looked at and restored.
  await canvas.getByRole("button", { name: "Older version" }).click();
  await expect(canvas.getByTestId("canvas-status")).toHaveText("Version 2 of 3 · edited by you");
  await expect(canvas.getByTestId("canvas-text")).not.toContainText("Revised by the AI.");
  await expect(canvas.getByRole("button", { name: "Restore" })).toBeVisible();
  await canvas.getByRole("button", { name: "Newer version" }).click();
  await expect(canvas.getByTestId("canvas-status")).toHaveText("Version 3 of 3 · written by the AI");

  // Export through the document maker.
  await canvas.getByRole("button", { name: "Copy or download" }).click();
  const [docx] = await Promise.all([page.waitForEvent("download"), page.getByRole("menuitem", { name: "Download as Word" }).click()]);
  expect(docx.suggestedFilename()).toBe("Wedding-speech.docx");
  const text = await documentText(DOCX, new Uint8Array(await readFile((await docx.path())!)));
  expect(text).toContain("My own line about Amir.");

  // Still there after a reload, from the header.
  await page.reload();
  await expect(page.getByTestId("canvas")).toHaveCount(0);
  await page.getByRole("button", { name: "Open canvas" }).click();
  await expect(page.getByTestId("canvas").getByTestId("canvas-status")).toHaveText("Version 3 of 3 · written by the AI");
  // An older reply's card opens the version that reply wrote.
  await page.getByRole("button", { name: "Close canvas" }).last().click();
  await page.getByTestId("reply").first().getByRole("button", { name: "Open Wedding speech in the canvas" }).click();
  await expect(page.getByTestId("canvas").getByTestId("canvas-status")).toHaveText("Version 1 of 3 · written by the AI");
  expect(errors.filter((e) => !/_rsc=.*access control checks/.test(e))).toEqual([]);
});
