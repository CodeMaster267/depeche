import { expect, test, type Page } from "@playwright/test";
import { OWNER, noSidewaysScroll, signInWithPassword, watchErrors } from "./helpers";

/**
 * Editing a sent message and regenerating a reply keep the old versions, and "‹ 1/2 ›" flips
 * between them. The stand-in AI quotes the question at the top of each reply, so replies can be
 * told apart.
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
  await dialog.getByRole("button", { name: /Gemini 3.8 Flash/ }).click();
  await expect(dialog).toHaveCount(0);
}

async function send(page: Page, text: string) {
  await page.getByLabel("Message Depeche").fill(text);
  await page.getByRole("button", { name: "Send" }).click();
  await settled(page);
}

async function settled(page: Page) {
  await expect(page.getByTestId("reply").last()).toBeVisible();
  await expect(page.locator("[aria-busy=true]")).toHaveCount(0, { timeout: 15_000 });
}

const answerTo = (page: Page, q: string) => page.getByTestId("reply").filter({ hasText: `worked answer to "${q}"` });

test("edit a sent message, flip between versions, and keep both after reloading", async ({ page }) => {
  const errors = watchErrors(page);
  await ready(page);
  await send(page, "Plan a picnic");
  await send(page, "Make it vegetarian");
  await expect(page.getByTestId("user-message")).toHaveCount(2);

  // Edit the first message: the conversation restarts from the edit.
  const first = page.getByTestId("user-message").first();
  await first.hover();
  await page.getByRole("button", { name: "Edit message" }).first().click();
  const box = page.getByLabel("Edit your message");
  await expect(box).toBeFocused();
  await box.fill("Plan a beach day");
  await page.getByRole("button", { name: "Send", exact: true }).first().click();
  await settled(page);
  await expect(page.getByTestId("user-message")).toHaveCount(1);
  await expect(page.getByTestId("user-message")).toHaveText("Plan a beach day");
  await expect(answerTo(page, "Plan a beach day")).toHaveCount(1);
  const versions = page.getByTestId("message-versions");
  await expect(versions).toContainText("2/2");

  // Back to version 1: the original question, its answer and the follow-up are all still there.
  await versions.getByRole("button", { name: "Previous version of this message" }).click();
  await expect(versions).toContainText("1/2");
  await expect(page.getByTestId("user-message")).toHaveText(["Plan a picnic", "Make it vegetarian"]);
  await expect(answerTo(page, "Make it vegetarian")).toHaveCount(1);

  // Carrying on from version 1 continues that conversation, not the newer one.
  await send(page, "Add dessert");
  await expect(page.getByTestId("user-message")).toHaveText(["Plan a picnic", "Make it vegetarian", "Add dessert"]);
  await expect(page.getByTestId("message-versions")).toContainText("1/2");

  // Reloading opens the newest conversation, and the other version is still one tap away.
  await page.reload();
  await expect(page.getByTestId("user-message")).toHaveText(["Plan a picnic", "Make it vegetarian", "Add dessert"]);
  // A tap that lands before the page has finished loading does nothing, so tap until it takes.
  await expect(async () => {
    const next = page.getByTestId("message-versions").getByRole("button", { name: "Next version of this message" });
    if (await next.isEnabled()) await next.click();
    await expect(page.getByTestId("user-message")).toHaveText(["Plan a beach day"], { timeout: 1_000 });
  }).toPass({ timeout: 10_000 });
  await noSidewaysScroll(page);
  expect(errors.filter((e) => !/_rsc=.*access control checks/.test(e))).toEqual([]);
});

test("try again on an earlier reply makes a second version of it", async ({ page }) => {
  await ready(page);
  await send(page, "Name a colour");
  await send(page, "Name a fruit");
  // Regenerate the first reply, not just the last one.
  await page.getByTestId("reply").first().getByRole("button", { name: "Try again" }).click();
  await settled(page);
  await expect(page.getByTestId("user-message")).toHaveText(["Name a colour"]);
  const versions = page.getByTestId("reply-versions");
  await expect(versions).toContainText("2/2");
  await versions.getByRole("button", { name: "Previous version of this reply" }).click();
  await expect(versions).toContainText("1/2");
  await expect(page.getByTestId("user-message")).toHaveText(["Name a colour", "Name a fruit"]);
});

test("cancelling an edit changes nothing", async ({ page }) => {
  await ready(page);
  await send(page, "Hello there");
  await page.getByTestId("user-message").hover();
  await page.getByRole("button", { name: "Edit message" }).click();
  const box = page.getByLabel("Edit your message");
  // An unchanged message can't be sent again as an edit.
  await expect(page.getByRole("button", { name: "Send", exact: true }).first()).toBeDisabled();
  await box.fill("Something else");
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByTestId("user-message")).toHaveText("Hello there");
  await expect(page.getByTestId("message-versions")).toHaveCount(0);
});
