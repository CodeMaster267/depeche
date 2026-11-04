import { expect, test, type Page } from "@playwright/test";
import { OWNER, admin, noSidewaysScroll, signInWithPassword, uniqueEmail, watchErrors } from "./helpers";

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

async function newMember(name: string) {
  const db = admin();
  const { data: owner } = await db.from("profiles").select("family_id").eq("is_app_owner", true).single();
  const email = uniqueEmail("gadget");
  const { data: user } = await db.auth.admin.createUser({ email, password: "member-password-123", email_confirm: true });
  await db.from("profiles").insert({ id: user.user!.id, family_id: owner!.family_id, display_name: name });
  return { email, id: user.user!.id };
}

test("a saved gadget asks an AI with the cost shown, remembers, changes by asking and is shared as a copy", async ({ page }) => {
  test.setTimeout(180_000);
  const errors = watchErrors(page);
  await ready(page);
  const reply = await ask(page, `Make me a game gadget ${Date.now()}`);
  const card = reply.getByTestId("widget");
  await expect(card.frameLocator("iframe").getByText("Remembered: nothing")).toBeVisible();
  // The AIs the family can use are offered to the gadget.
  await expect(card.frameLocator("iframe").locator("#models")).toContainText("Gemini 3.8 Flash");

  await card.getByRole("button", { name: "Save to My gadgets" }).click();
  await card.getByTestId("gadget-saved").click();
  await expect(page).toHaveURL(/\/gadgets\/[0-9a-f-]{36}$/);
  const gadgetUrl = page.url();
  await expect(page.getByTestId("gadget-title")).toHaveText("Word game");
  const tool = page.frameLocator("iframe[title='Word game']");

  // Asking an AI goes through Depeche, and every answer shows what it cost.
  await tool.getByRole("button", { name: "Your move, AI" }).click();
  await expect(tool.locator("#answer")).toContainText("says: What is your move?");
  await expect(page.getByTestId("gadget-cost")).toContainText(/That cost .*¢.*so far\. It counts toward your spending\./);

  // What it saves is still there next time.
  await tool.getByRole("button", { name: "Remember the score" }).click();
  await expect(tool.locator("#loaded")).toHaveText("saved");
  await page.reload();
  await expect(page.frameLocator("iframe[title='Word game']").locator("#loaded")).toHaveText('{"score":3}');

  // Changed by asking; the earlier version stays and can be brought back.
  await page.getByLabel("What should change?").fill("add a hint button");
  await page.getByRole("button", { name: "Change it" }).click();
  await expect(page.getByTestId("change-note")).toContainText("I've made that change.");
  await expect(page.frameLocator("iframe[title='Word game']").locator("#changed")).toHaveText("Changed: add a hint button");
  const versions = page.getByTestId("gadget-versions");
  await expect(versions.locator("li")).toHaveCount(2);
  await versions.getByRole("button", { name: "Go back to this" }).click();
  await expect(versions.locator("li")).toHaveCount(3);
  await expect(page.frameLocator("iframe[title='Word game']").locator("#changed")).toHaveCount(0);

  // Shared on the family shelf: someone else adds their own copy, without the saved score.
  await page.getByLabel("Share with").selectOption("family");
  await page.getByRole("button", { name: "Share a copy" }).click();
  await expect(page.getByText("On the family shelf.")).toBeVisible();
  await noSidewaysScroll(page);
  expect(errors.filter((e) => !/_rsc=.*access control checks/.test(e))).toEqual([]);

  const zara = await newMember("Zara");
  await page.context().clearCookies();
  await signInWithPassword(page, zara.email, "member-password-123");
  await expect(page.getByRole("heading", { name: "Hi, Zara." })).toBeVisible();
  // Not hers: the owner's gadget page is not found.
  await page.goto(gadgetUrl);
  await expect(page.getByText(/could not be found|not found/i).first()).toBeVisible();
  await expect(page.getByTestId("gadget-title")).toHaveCount(0);
  await expect(page.locator("iframe[title='Word game']")).toHaveCount(0);
  await page.goto("/gadgets");
  const row = page.getByTestId("family-shelf").getByTestId("share-row").filter({ hasText: "Word game" }).first();
  await expect(row).toContainText("From Hasan");
  await row.getByRole("button", { name: "Add to mine" }).click();
  await expect(page).toHaveURL(/\/gadgets\/[0-9a-f-]{36}$/);
  expect(page.url()).not.toBe(gadgetUrl);
  await expect(page.frameLocator("iframe[title='Word game']").locator("#loaded")).toHaveText("nothing");
});

test("an admin can take away someone's monthly limit, and put it back", async ({ page }) => {
  const member = await newMember("Omar");
  await signInWithPassword(page, OWNER.email, OWNER.password);
  await expect(page.getByRole("heading", { name: "Hi, Hasan." })).toBeVisible();
  await page.goto("/family");
  const row = page.getByTestId("member-row").filter({ hasText: "Omar" }).last();
  await row.getByRole("button", { name: /Omar/ }).click();
  await row.getByLabel("No limit").check();
  await row.getByRole("button", { name: "Save limit" }).click();
  await expect(row.getByText("Saved. No limit.")).toBeVisible();
  await expect(row.getByRole("button", { name: /Omar/ })).toContainText("no limit");
  await expect(page.getByTestId("admin-log")).toContainText("took away Omar's monthly limit");

  await page.context().clearCookies();
  await signInWithPassword(page, member.email, "member-password-123");
  await expect(page.getByRole("heading", { name: "Hi, Omar." })).toBeVisible();
  const open = page.getByRole("button", { name: "Open menu" });
  if (await open.isVisible()) await open.click();
  const account = page.getByRole("button", { name: /account menu/ }).filter({ visible: true });
  await expect(account).toContainText("no limit");
  await account.click();
  await expect(page.getByTestId("spending").filter({ visible: true })).toContainText("no limit");
});
