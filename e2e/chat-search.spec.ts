import { expect, test, type Page } from "@playwright/test";
import { OWNER, noSidewaysScroll, signInWithPassword, watchErrors } from "./helpers";

/**
 * "Search this chat". The stand-in AI (DEPECHE_FAKE_AI) is always given the lookup, and when a
 * message asks "what did I say about X" it looks X up and quotes the earlier message it found.
 * With a real model the lookup is offered only once older messages are summarised or left out.
 */

async function start(page: Page) {
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
  await page.getByRole("dialog", { name: "Choose a model" }).getByRole("button", { name: /Gemini 3\.8 Flash/ }).click();
  await expect(page.getByRole("button", { name: /Model: Gemini 3\.8 Flash/ })).toBeVisible();
}

async function send(page: Page, text: string) {
  await page.getByLabel("Message Depeche").fill(text);
  await page.getByRole("button", { name: "Send" }).click();
}

test("a reply looks back through the chat and quotes the earlier message word for word", async ({ page }) => {
  const errors = watchErrors(page);
  await start(page);
  const ref = `ZQ${Date.now()}`;
  const said = `The boiler quote from Smith & Sons was £450, reference ${ref}.`;
  await send(page, said);
  const first = page.getByTestId("reply").last();
  await expect(first).not.toHaveAttribute("aria-busy", "true", { timeout: 15_000 });

  await send(page, `slowly, what did I say about ${ref}?`);
  const reply = page.getByTestId("reply").last();
  const looking = reply.getByTestId("searching");
  await expect(looking).toHaveAttribute("data-where", "chat");
  await expect(looking).toHaveText(`Looking back through this chat for “${ref}”`);
  await expect(reply).not.toHaveAttribute("aria-busy", "true", { timeout: 15_000 });
  await expect(reply.getByTestId("searching")).toHaveCount(0);
  await expect(reply).toContainText("Earlier in this chat (message 1) you said:");
  await expect(reply.locator("blockquote")).toHaveText(said);
  // Looking back is free: no web-search fee is counted for it.
  await expect(reply.getByTestId("sources")).toHaveCount(0);
  await noSidewaysScroll(page);
  // Safari reports cancelled page prefetches as errors; that is the browser, not Depeche.
  expect(errors.filter((e) => !/_rsc=.*access control checks/.test(e))).toEqual([]);

  // After a reload the saved reply is the same.
  await page.reload();
  await expect(page.getByTestId("reply").last().locator("blockquote")).toHaveText(said);
});
