import { expect, test, type Page } from "@playwright/test";
import { OWNER, admin, signInWithPassword, uniqueEmail } from "./helpers";

/** The family needs a Google key for Gemini; the owner adds a test key if it's missing. */
async function familyHasGoogleKey(page: Page) {
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
  await page.context().clearCookies();
}

/** Memory: a reply can suggest a fact, which is kept only if the person says so. */
test("a suggested memory is kept with a tap, used later, and can be forgotten", async ({ page }) => {
  await familyHasGoogleKey(page);
  // A person of their own, so their memories don't mix with other tests.
  const db = admin();
  const email = uniqueEmail("mem");
  const { data: user } = await db.auth.admin.createUser({ email, password: "member-password-123", email_confirm: true });
  const { data: owner } = await db.from("profiles").select("family_id").eq("is_app_owner", true).single();
  await db.from("profiles").insert({ id: user.user!.id, family_id: owner!.family_id, display_name: "Mo" });

  await signInWithPassword(page, email, "member-password-123");
  await expect(page.getByRole("heading", { name: "Hi, Mo." })).toBeVisible();
  await page.getByRole("button", { name: /Change model/ }).click();
  const dialog = page.getByRole("dialog", { name: "Choose a model" });
  await dialog.getByRole("button", { name: /Gemini 3\.8 Flash/ }).click();
  await expect(dialog).toHaveCount(0);

  await page.getByLabel("Message Depeche").fill("My favourite colour is black");
  await page.getByRole("button", { name: "Send" }).click();
  const reply = page.getByTestId("reply").last();
  await expect(reply).not.toHaveAttribute("aria-busy", "true", { timeout: 15_000 });
  // The tag never shows in the reply; the suggestion is offered instead.
  await expect(reply).not.toContainText("<remember>");
  const card = reply.getByTestId("memory-suggestion");
  // The fact appears once, in the suggestion, not in the reply's text.
  await expect(reply.getByText("Their favourite colour is black.")).toHaveCount(1);
  await expect(card).toContainText("Their favourite colour is black.");

  // Still offered after a reload, until answered.
  await page.reload();
  await expect(page.getByTestId("memory-suggestion")).toBeVisible();
  // Safari can take a tap before the reloaded page is ready for it; tap again if nothing happened.
  await expect(async () => {
    const remember = page.getByTestId("memory-suggestion").getByRole("button", { name: "Remember" });
    if (await remember.isVisible()) await remember.click();
    await expect(page.getByText("Remembered.")).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 15_000 });
  // "Remembered." shows at once while the save is still on its way; leaving the page too soon
  // can cancel it, so wait until it is stored.
  await expect
    .poll(async () => (await db.from("memories").select("status").eq("owner_id", user.user!.id).eq("status", "active")).data?.length)
    .toBe(1);

  await page.goto("/memory");
  await expect(page.getByTestId("memories")).toContainText("Their favourite colour is black.");
  await page.getByLabel("Add something").fill("I like short answers.");
  await page.getByRole("button", { name: "Remember" }).click();
  await expect(page.getByTestId("memories")).toContainText("I like short answers.");

  await page.getByRole("button", { name: "Forget: I like short answers." }).click();
  await expect(page.getByTestId("memories")).not.toContainText("I like short answers.");
  await expect(page.getByTestId("memories")).toContainText("Their favourite colour is black.");
});

test("a dismissed suggestion is never kept", async ({ page }) => {
  await familyHasGoogleKey(page);
  const db = admin();
  const email = uniqueEmail("nomem");
  const { data: user } = await db.auth.admin.createUser({ email, password: "member-password-123", email_confirm: true });
  const { data: owner } = await db.from("profiles").select("family_id").eq("is_app_owner", true).single();
  await db.from("profiles").insert({ id: user.user!.id, family_id: owner!.family_id, display_name: "Noor" });

  await signInWithPassword(page, email, "member-password-123");
  await expect(page.getByRole("heading", { name: "Hi, Noor." })).toBeVisible();
  await page.getByRole("button", { name: /Change model/ }).click();
  await page.getByRole("dialog", { name: "Choose a model" }).getByRole("button", { name: /Gemini 3\.8 Flash/ }).click();
  await page.getByLabel("Message Depeche").fill("My favourite colour is black");
  await page.getByRole("button", { name: "Send" }).click();
  // As above: tap again if Safari took the tap before the page was ready for it.
  await expect(page.getByTestId("memory-suggestion")).toBeVisible({ timeout: 15_000 });
  await expect(async () => {
    const noThanks = page.getByTestId("memory-suggestion").getByRole("button", { name: "No thanks" });
    if (await noThanks.isVisible()) await noThanks.click();
    await expect(page.getByTestId("memory-suggestion")).toHaveCount(0, { timeout: 3_000 });
  }).toPass({ timeout: 15_000 });
  await expect
    .poll(async () => (await db.from("memories").select("status").eq("owner_id", user.user!.id).single()).data?.status)
    .toBe("rejected");
  await page.goto("/memory");
  await expect(page.getByText("Nothing yet.")).toBeVisible();
});
