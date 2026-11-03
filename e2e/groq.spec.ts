import { expect, test, type Page } from "@playwright/test";
import { OWNER, noSidewaysScroll, signInWithPassword, watchErrors } from "./helpers";

/**
 * Groq as a fourth provider. The stand-in AI (DEPECHE_FAKE_AI) acts as if a Groq model's free-tier
 * allowance is used up when a message says "ratelimit" (and for the model that steps in too with
 * "ratelimitall"), using Groq's own wording.
 */

async function start(page: Page) {
  await signInWithPassword(page, OWNER.email, OWNER.password);
  await expect(page.getByRole("heading", { name: "Hi, Hasan." })).toBeVisible();
  await page.goto("/family");
  const row = page.getByTestId("provider-groq");
  await expect(row.getByText("Groq (open models)", { exact: true })).toBeVisible();
  await expect(row.getByText(/Not added|ends in/)).toBeVisible();
  if (await row.getByText("Not added").isVisible()) {
    await expect(row.getByText(/rate-limited/)).toBeVisible();
    await row.getByLabel("Groq (open models) API key").fill("test-groq-key-1234567890gsk_");
    await row.getByRole("button", { name: "Save key" }).click();
    await expect(row.getByText(/ends in/)).toBeVisible();
  }
  await expect(row.getByTestId("key-models")).toHaveText("Can use GPT-OSS 120B, GPT-OSS 20B, Qwen 3.8 27B");
  await page.goto("/");
  await page.getByRole("button", { name: /Change model/ }).click();
  const dialog = page.getByRole("dialog", { name: "Choose a model" });
  await expect(dialog.getByText("Groq", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: /GPT-OSS 120B/ }).click();
  await expect(page.getByRole("button", { name: /Model: GPT-OSS 120B/ })).toBeVisible();
}

async function send(page: Page, text: string) {
  await page.getByLabel("Message Depeche").fill(text);
  await page.getByRole("button", { name: "Send" }).click();
}

test.describe("Groq", () => {
  test.describe.configure({ mode: "serial" });

  test("GPT-OSS searches the web with its sources shown; Qwen can't search", async ({ page }) => {
    const errors = watchErrors(page);
    await start(page);
    const globe = page.getByRole("button", { name: "Search the web" });
    await expect(globe).toBeEnabled();
    await expect(globe).toHaveAttribute("aria-pressed", "true");

    await send(page, `What's the latest? ${Date.now()}`);
    const reply = page.getByTestId("reply").last();
    await expect(reply).not.toHaveAttribute("aria-busy", "true", { timeout: 15_000 });
    await expect(reply.locator("a.cite").first()).toHaveText("1");
    const sources = reply.getByTestId("sources");
    await sources.getByRole("button", { name: /3 sources/ }).click();
    await expect(sources.getByText("2 web searches, included in the cost below.")).toBeVisible();
    await expect(reply.getByText(/^GPT-OSS 120B · \$/)).toBeVisible();

    // Qwen has no search on Groq, so the globe is off and can't be turned on.
    await page.getByRole("button", { name: /Change model/ }).click();
    await page.getByRole("dialog", { name: "Choose a model" }).getByRole("button", { name: /Qwen 3\.8 27B/ }).click();
    await expect(globe).toBeDisabled();
    await expect(globe).toHaveAttribute("aria-pressed", "false");
    await send(page, `What's the latest from Qwen? ${Date.now()}`);
    const plain = page.getByTestId("reply").last();
    await expect(plain).not.toHaveAttribute("aria-busy", "true", { timeout: 15_000 });
    await expect(plain).toContainText("worked answer");
    await expect(plain.getByTestId("sources")).toHaveCount(0);
    await expect(plain.getByText(/^Qwen 3\.8 27B · \$/)).toBeVisible();
    await noSidewaysScroll(page);
    expect(errors.filter((e) => !/_rsc=.*access control checks/is.test(e))).toEqual([]);
  });

  test("when one model's free-tier limit is reached, another answers and says so", async ({ page }) => {
    await start(page);
    await send(page, `ratelimit ${Date.now()}`);
    const reply = page.getByTestId("reply").last();
    await expect(reply).not.toHaveAttribute("aria-busy", "true", { timeout: 15_000 });
    await expect(reply).toContainText("worked answer");
    await expect(reply.getByText("GPT-OSS 120B (Groq) reached its free-tier limit, so GPT-OSS 20B (Groq) answered instead.")).toBeVisible();
    await expect(reply.getByText(/^GPT-OSS 20B · \$/)).toBeVisible();
  });

  test("when every model's limit is reached, Groq's own message is shown", async ({ page }) => {
    await start(page);
    await send(page, `ratelimitall ${Date.now()}`);
    const reply = page.getByTestId("reply").last();
    await expect(reply).not.toHaveAttribute("aria-busy", "true", { timeout: 15_000 });
    await expect(reply).toContainText("Groq's free tier allows only so much a minute, and that's used up. Try again in 3 seconds.");
    await expect(reply).toContainText('Groq said: "Rate limit reached for model');
  });
});
