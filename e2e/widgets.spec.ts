import { expect, test, type Page } from "@playwright/test";
import { OWNER, noSidewaysScroll, signInWithPassword, watchErrors } from "./helpers";

/**
 * Gadgets (small interactive apps) in replies. The stand-in model builds a tip calculator for "tip calculator"
 * and, for "escape test", a tool that tries every way out of its sealed frame (the page, storage,
 * cookies, pop-ups, our API, the internet, an outside picture), which must all be blocked.
 */

test.setTimeout(120_000);

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

async function ask(page: Page, text: string) {
  const box = page.getByLabel("Message Depeche");
  const send = page.getByRole("button", { name: "Send" });
  await expect(async () => {
    await box.fill(text);
    await expect(send).toBeEnabled({ timeout: 1000 });
  }).toPass({ timeout: 10_000 });
  await send.click();
  const reply = page.getByTestId("reply").last();
  await expect(reply).not.toHaveAttribute("aria-busy", "true", { timeout: 15_000 });
  return reply;
}

test("a gadget the model builds works in the reply and can hand a result back to the chat", async ({ page }) => {
  const errors = watchErrors(page);
  await ready(page);
  const reply = await ask(page, `Make me a tip calculator ${Date.now()}`);
  // The tool's own reply (sending its result below adds another reply after it).
  const card = page.getByTestId("widget").filter({ hasText: "Tip calculator" }).last();
  await expect(card.getByText("Tip calculator")).toBeVisible();

  const tool = card.frameLocator("iframe[title='Tip calculator']");
  await expect(tool.getByText("Each pays £46.00")).toBeVisible();
  await tool.getByLabel("Bill").fill("100");
  await expect(tool.getByText("Each pays £115.00")).toBeVisible();
  // The frame grows to fit the tool, so nothing inside is cut off.
  const frameBox = (await card.locator("iframe").boundingBox())!;
  expect(frameBox.height).toBeGreaterThan(180);

  // Handing a result back asks first, then sends it as the person's message.
  await tool.getByRole("button", { name: "Share with the chat" }).click();
  const offer = card.getByTestId("widget-offer");
  await expect(offer).toContainText("The total with tip is £115.00");
  await offer.getByRole("button", { name: "Send" }).click();
  await expect(page.getByTestId("user-message").last()).toHaveText("The total with tip is £115.00");
  await expect(page.getByTestId("reply").last()).not.toHaveAttribute("aria-busy", "true", { timeout: 15_000 });

  // How it's made can be read, and Start over reloads it.
  await card.getByRole("button", { name: "See how it's made" }).click();
  await expect(card.getByTestId("widget-code")).toContainText("depeche.send");
  await card.getByRole("button", { name: "Start over" }).click();
  await expect(tool.getByText("Each pays £46.00")).toBeVisible();

  await noSidewaysScroll(page);
  expect(errors.filter((e) => !/_rsc=.*access control checks/.test(e))).toEqual([]);
});

test("a gadget can't reach the page, your account, storage or the internet", async ({ page }) => {
  await ready(page);
  const reply = await ask(page, `Run the escape test ${Date.now()}`);
  const tool = reply.getByTestId("widget").frameLocator("iframe");
  for (const check of ["parent page", "storage", "cookies", "pop-up", "app api", "internet", "outside picture"]) {
    await expect(tool.locator(`[data-check="${check}"]`)).toHaveText(`${check}: blocked`, { timeout: 15_000 });
  }
  await expect(tool.getByText("OPEN")).toHaveCount(0);
  // The app itself is untouched and still signed in.
  await expect(page.getByLabel("Message Depeche")).toBeVisible();
  expect(page.url()).toMatch(/localhost:3100\/c\//);
});
