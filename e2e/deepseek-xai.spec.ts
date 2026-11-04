import { expect, test, type Page } from "@playwright/test";
import { OWNER, noSidewaysScroll, signInWithPassword, watchErrors } from "./helpers";

/**
 * DeepSeek and xAI's Grok as providers. Each family admin adds their own key in Family settings;
 * the stand-in AI (DEPECHE_FAKE_AI) accepts keys starting "test-" and streams a canned reply.
 */

/**
 * Safari sometimes refuses a navigation that starts while the page is still finishing its own (it
 * says "WebKit encountered an internal error"), so the navigation is tried again.
 */
async function go(page: Page, url: string) {
  await expect(async () => {
    await page.goto(url, { timeout: 10_000 });
  }).toPass({ timeout: 30_000 });
}

async function addKey(page: Page, id: string, name: string, hint: RegExp, models: string) {
  const row = page.getByTestId(`provider-${id}`);
  await expect(row.getByText(name, { exact: true })).toBeVisible();
  await expect(row.getByText(/Not added|ends in/)).toBeVisible();
  if (await row.getByText("Not added").isVisible()) {
    await expect(row.getByText(hint)).toBeVisible();
    await row.getByLabel(`${name} API key`).fill(`test-${id}-key-1234567890abcd`);
    await row.getByRole("button", { name: "Save key" }).click();
    await expect(row.getByText(/ends in/)).toBeVisible();
  }
  await expect(row.getByTestId("key-models")).toHaveText(models);
}

async function pick(page: Page, group: string, model: RegExp, label: RegExp) {
  // Safari can take a tap before the page is ready for it; open the picker again if nothing happened.
  await expect(async () => {
    if (await page.getByRole("button", { name: label }).isVisible()) return;
    const dialog = page.getByRole("dialog", { name: "Choose a model" });
    if (!(await dialog.isVisible())) await page.getByRole("button", { name: /Change model/ }).click();
    await expect(dialog.getByText(group, { exact: true })).toBeVisible({ timeout: 3_000 });
    await dialog.getByRole("button", { name: model }).click();
    await expect(page.getByRole("button", { name: label })).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 20_000 });
}

async function send(page: Page, text: string) {
  const replies = page.getByTestId("reply");
  const before = await replies.count();
  await page.getByLabel("Message Depeche").fill(text);
  await page.getByRole("button", { name: "Send" }).click();
  // Wait for this message's reply to appear and finish, not an earlier one.
  await expect(replies).toHaveCount(before + 1, { timeout: 15_000 });
  const reply = replies.last();
  await expect(reply).not.toHaveAttribute("aria-busy", "true", { timeout: 20_000 });
  return reply;
}

test.describe("DeepSeek and Grok", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeEach(async ({ page }) => {
    await signInWithPassword(page, OWNER.email, OWNER.password);
    await expect(page.getByRole("heading", { name: "Hi, Hasan." })).toBeVisible();
    await go(page, "/family");
    await addKey(page, "deepseek", "DeepSeek", /No web search/, "Can use DeepSeek V4 Pro, DeepSeek Flash");
    await addKey(page, "xai", "xAI (Grok)", /Grok can search the web/, "Can use Grok 4.7, Grok 4.3, Grok Imagine");
    await go(page, "/");
    await expect(page.getByLabel("Message Depeche")).toBeEditable();
  });

  test("DeepSeek answers, and the web search button is off while it's picked", async ({ page }) => {
    const errors = watchErrors(page);
    await pick(page, "DeepSeek", /DeepSeek V4 Pro/, /Model: DeepSeek V4 Pro/);
    const globe = page.getByRole("button", { name: "Search the web" });
    await expect(globe).toBeDisabled();
    await expect(globe).toHaveAttribute("aria-pressed", "false");
    const reply = await send(page, `Solve 2x² − 7x + 3 = 0 ${Date.now()}`);
    await expect(reply).toContainText("worked answer");
    await expect(reply.getByTestId("sources")).toHaveCount(0);
    await expect(reply.getByText(/^DeepSeek V4 Pro · \$/)).toBeVisible();
    await noSidewaysScroll(page);
    expect(errors.filter((e) => !/_rsc=.*access control checks/is.test(e))).toEqual([]);
  });

  test("Grok searches the web with its sources shown", async ({ page }) => {
    const errors = watchErrors(page);
    await pick(page, "xAI", /Grok 4\.7/, /Model: Grok 4\.7/);
    const globe = page.getByRole("button", { name: "Search the web" });
    await expect(globe).toBeEnabled();
    // The saved on/off choice loads after the page does, so keep tapping until it reads on.
    await expect(async () => {
      if ((await globe.getAttribute("aria-pressed")) !== "true") await globe.click();
      await expect(globe).toHaveAttribute("aria-pressed", "true", { timeout: 2_000 });
    }).toPass({ timeout: 15_000 });
    const reply = await send(page, `What's the latest? ${Date.now()}`);
    await expect(reply.locator("a.cite").first()).toHaveText("1");
    const sources = reply.getByTestId("sources");
    await sources.getByRole("button", { name: /3 sources/ }).click();
    await expect(sources.getByText("2 web searches, included in the cost below.")).toBeVisible();
    await expect(reply.getByText(/^Grok 4\.7 · \$/)).toBeVisible();
    await noSidewaysScroll(page);
    expect(errors.filter((e) => !/_rsc=.*access control checks/is.test(e))).toEqual([]);
  });
});
