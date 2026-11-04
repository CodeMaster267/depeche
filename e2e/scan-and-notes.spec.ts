import { expect, test, type Page } from "@playwright/test";
import { OWNER, admin, signInWithPassword, watchErrors } from "./helpers";

/**
 * Scanning pages into a PDF, and voice notes written out as text. Both run their real browser
 * code: the scanner finds, straightens and cleans each page on the device; a recording goes to
 * private storage and the server's stand-in AI writes it out as "What is the quadratic formula?".
 */

async function ready(page: Page) {
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
  await page.goto("/");
  await page.getByRole("button", { name: /Change model/ }).click();
  const dialog = page.getByRole("dialog", { name: "Choose a model" });
  await dialog.getByRole("button", { name: /Gemini 3\.8 Flash/ }).click();
  await expect(dialog).toHaveCount(0);
}

/** Two seconds of a quiet tone as a WAV file. */
function wav(seconds = 2, rate = 16_000): Buffer {
  const samples = seconds * rate;
  const b = Buffer.alloc(44 + samples * 2);
  b.write("RIFF", 0);
  b.writeUInt32LE(36 + samples * 2, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) b.writeInt16LE(Math.round(Math.sin((i / rate) * 2 * Math.PI * 220) * 3000), 44 + i * 2);
  return b;
}

/** A photo of a white page lying a little crooked on a dark table, drawn in the page. */
async function pagePhoto(page: Page, words: string): Promise<Buffer> {
  const data = await page.evaluate((text) => {
    const c = document.createElement("canvas");
    c.width = 900;
    c.height = 1200;
    const g = c.getContext("2d")!;
    g.fillStyle = "#3a3530";
    g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = "#e9e4da";
    g.beginPath();
    g.moveTo(140, 110);
    g.lineTo(780, 160);
    g.lineTo(740, 1080);
    g.lineTo(110, 1040);
    g.closePath();
    g.fill();
    g.fillStyle = "#222";
    g.font = "48px sans-serif";
    g.fillText(text, 220, 400);
    return c.toDataURL("image/jpeg", 0.9).split(",")[1];
  }, words);
  return Buffer.from(data, "base64");
}

test("the attach button offers files, scanning and voice notes", async ({ page }) => {
  await ready(page);
  await page.getByRole("button", { name: "Attach", exact: true }).click();
  const menu = page.getByRole("menu", { name: "Attach" });
  await expect(menu.getByRole("menuitem")).toHaveText(["Photos and files", "Scan pages", "Voice note or recording"]);
  await page.keyboard.press("Escape");
});

test("a voice note is written out and sent as its transcript, and the recording isn't kept", async ({ page }) => {
  const errors = watchErrors(page);
  await ready(page);
  await page.getByTestId("audio-input").setInputFiles([{ name: "Lecture notes.wav", mimeType: "audio/wav", buffer: wav() }]);
  const tile = page.getByTestId("attachment");
  await expect(tile).toHaveAttribute("data-status", "ready", { timeout: 20_000 });
  await expect(tile).toContainText("Lecture notes transcript.txt");
  await expect(tile).toContainText("Transcript");

  await page.getByLabel("Message Depeche").fill("Summarise this");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByTestId("reply").last()).toContainText("I can see Lecture notes transcript.txt.", { timeout: 15_000 });

  // The transcript is an ordinary private upload; the recording itself is gone.
  const db = admin();
  const { data: owner } = await db.from("profiles").select("id").eq("is_app_owner", true).single();
  const { data: msg } = await db
    .from("messages")
    .select("content")
    .eq("role", "user")
    .eq("owner_id", owner!.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .single<{ content: { files: { path: string; name: string }[] } }>();
  const file = msg!.content.files[0];
  const { data: text } = await db.storage.from("uploads").download(file.path);
  expect(await text!.text()).toMatch(/^Transcript of Lecture notes\.wav \(0:02\)\n\nWhat is the quadratic formula\?/);
  const folder = file.path.split("/").slice(0, 2).join("/");
  const { data: left } = await db.storage.from("voice-notes").list(folder);
  expect(left ?? []).toEqual([]);
  expect(errors.filter((e) => !/_rsc=.*access control checks/.test(e))).toEqual([]);
});

test("a recording Depeche can't read says so", async ({ page }) => {
  await ready(page);
  await page.getByTestId("audio-input").setInputFiles([{ name: "call.caf", mimeType: "audio/x-caf", buffer: Buffer.from("caff") }]);
  await expect(page.getByTestId("attachment")).toHaveAttribute("data-status", "error");
  await expect(page.getByTestId("attachment")).toContainText("Save it as .m4a or .mp3");
});

test("pages are scanned, cropped, cleaned up, reordered and attached as one PDF", async ({ page }) => {
  const errors = watchErrors(page);
  await ready(page);
  const first = await pagePhoto(page, "Page one");

  // One photo opens for cropping, with the page's corners already found.
  await page.getByTestId("scan-input").setInputFiles([{ name: "IMG_0001.jpg", mimeType: "image/jpeg", buffer: first }]);
  const sheet = page.getByRole("dialog", { name: "New page" });
  await expect(sheet).toBeVisible({ timeout: 15_000 });
  const corner = sheet.getByTestId("corner-0");
  await expect(corner).toBeVisible();
  const crop = await sheet.getByTestId("crop").boundingBox();
  const at = await corner.boundingBox();
  // Found near the page's real top-left corner (140, 110 of 900 × 1200).
  expect((at!.x + at!.width / 2 - crop!.x) / crop!.width).toBeCloseTo(140 / 900, 1);
  expect((at!.y + at!.height / 2 - crop!.y) / crop!.height).toBeCloseTo(110 / 1200, 1);
  // Corners can be dragged, and moved with the keyboard.
  await page.mouse.move(at!.x + at!.width / 2, at!.y + at!.height / 2);
  await page.mouse.down();
  await page.mouse.move(at!.x + at!.width / 2 + 10, at!.y + at!.height / 2 + 10, { steps: 4 });
  await page.mouse.up();
  const moved = await corner.boundingBox();
  expect(moved!.x).toBeGreaterThan(at!.x + 5);
  await corner.focus();
  await page.keyboard.press("ArrowLeft");
  expect((await corner.boundingBox())!.x).toBeLessThan(moved!.x);

  await sheet.getByRole("radio", { name: "B&W" }).click();
  await expect(sheet.getByTestId("scan-preview")).toBeVisible({ timeout: 15_000 });
  await sheet.getByRole("button", { name: "Keep" }).click();

  const scanner = page.getByRole("dialog", { name: "Scan pages" });
  await expect(scanner.getByTestId("scan-page")).toHaveCount(1);

  // Several photos at once go straight in as pages.
  await scanner
    .getByTestId("scan-photos")
    .setInputFiles([
      { name: "IMG_0002.jpg", mimeType: "image/jpeg", buffer: await pagePhoto(page, "Page two") },
      { name: "IMG_0003.jpg", mimeType: "image/jpeg", buffer: await pagePhoto(page, "Page three") },
    ]);
  await expect(scanner.getByTestId("scan-page")).toHaveCount(3, { timeout: 20_000 });
  await expect(scanner.getByRole("heading", { name: "3 pages" })).toBeVisible();

  // Move the first page to second place.
  await scanner.getByRole("button", { name: "Page 1: edit" }).click();
  const editor = page.getByRole("dialog", { name: "Page 1" });
  await editor.getByRole("button", { name: "Move later" }).click();
  await expect(page.getByRole("dialog", { name: "Page 2" })).toBeVisible();
  await page.getByRole("dialog", { name: "Page 2" }).getByRole("button", { name: "Done" }).click();

  await scanner.getByLabel("PDF name").fill("Homework");
  await expect(scanner.getByText(/\d+ KB|\d+\.\d MB/)).toBeVisible({ timeout: 15_000 });
  await scanner.getByRole("button", { name: "Attach" }).click();
  await expect(scanner).toHaveCount(0);
  const tile = page.getByTestId("attachment");
  await expect(tile).toHaveAttribute("data-status", "ready", { timeout: 15_000 });
  await expect(tile).toContainText("Homework.pdf");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByTestId("reply").last()).toContainText("I can see Homework.pdf.", { timeout: 15_000 });

  // The uploaded PDF has the three pages.
  const db = admin();
  const { data: owner } = await db.from("profiles").select("id").eq("is_app_owner", true).single();
  const { data: msg } = await db
    .from("messages")
    .select("content")
    .eq("role", "user")
    .eq("owner_id", owner!.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .single<{ content: { files: { path: string }[] } }>();
  const { data: pdf } = await db.storage.from("uploads").download(msg!.content.files[0].path);
  const { PDFDocument } = await import("pdf-lib");
  const doc = await PDFDocument.load(new Uint8Array(await pdf!.arrayBuffer()));
  expect(doc.getPageCount()).toBe(3);
  expect(doc.getTitle()).toBe("Homework");
  expect(errors.filter((e) => !/_rsc=.*access control checks/.test(e))).toEqual([]);
});
