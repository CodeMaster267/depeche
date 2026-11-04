import { expect, test, type Page } from "@playwright/test";
import { OWNER, admin, noSidewaysScroll, signInWithPassword, uniqueEmail, watchErrors } from "./helpers";

/**
 * Concierge, the help assistant. With the stand-in AI (DEPECHE_FAKE_AI) it answers with a fixed
 * reply that shows the person's role and family keys reached it, as the real one's instructions do.
 */

/** Concierge needs an AI key in the family; the owner's test Google key is added if it isn't there. */
async function ensureKey(page: Page) {
  const db = admin();
  const { data: owner } = await db.from("profiles").select("family_id").eq("is_app_owner", true).single();
  const { data: key } = await db.from("provider_keys").select("id").eq("family_id", owner!.family_id).eq("provider", "google").maybeSingle();
  if (key) return;
  await signInWithPassword(page, OWNER.email, OWNER.password);
  await expect(page.getByRole("heading", { name: `Hi, ${OWNER.name}.` })).toBeVisible();
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

/** Open Concierge from the side menu (behind the menu button on phones). */
async function openFromMenu(page: Page) {
  await expect(async () => {
    const open = page.getByRole("button", { name: "Open menu" });
    if (await open.isVisible()) await open.click();
    await page.locator("[data-part=concierge-link]:visible").click({ timeout: 3_000 });
    await expect(page.getByRole("dialog", { name: "Concierge" })).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 20_000 });
  return page.getByRole("dialog", { name: "Concierge" });
}

test("an admin asks where keys go and taps straight through to Family", async ({ page }) => {
  await ensureKey(page);
  const errors = watchErrors(page);
  await signInWithPassword(page, OWNER.email, OWNER.password);
  await expect(page.getByRole("heading", { name: `Hi, ${OWNER.name}.` })).toBeVisible();

  const panel = await openFromMenu(page);
  await expect(panel.getByRole("heading", { name: "Concierge" })).toBeVisible();
  await noSidewaysScroll(page);
  await panel.getByRole("button", { name: "Where do I put my xAI key?" }).click();
  const answer = panel.locator("[data-part=concierge-answer]");
  await expect(answer).toContainText("As a family admin");
  await expect(answer).toContainText("google");
  await expect(panel.getByText(/Answers by .+\. Knows Depeche, not your chats/)).toBeVisible();

  // An in-app link opens the page here, not in a new tab, and closes the panel.
  await answer.getByRole("link", { name: "Family → AI providers" }).click();
  await expect(page).toHaveURL(/\/family#ai-providers$/);
  await expect(page.getByRole("dialog", { name: "Concierge" })).toBeHidden();

  // The bell at the top of settings pages opens it again, with the conversation still there. An
  // admin's top bar is full on a phone, so there it's only in the side menu (on the chat screen).
  if (await page.getByRole("button", { name: "Ask Concierge" }).isVisible()) await page.getByRole("button", { name: "Ask Concierge" }).click();
  else {
    await page.goto("/");
    await openFromMenu(page);
  }
  const again = page.getByRole("dialog", { name: "Concierge" });
  await expect(again.getByText("Where do I put my xAI key?", { exact: true })).toBeVisible();
  await noSidewaysScroll(page);
  await again.getByRole("button", { name: "Clear" }).click();
  await expect(again.getByRole("button", { name: "How do I lock Depeche with Face ID?" })).toBeVisible();
  await again.getByRole("button", { name: "Close", exact: true }).click();
  await expect(again).toBeHidden();
  expect(errors).toEqual([]);
});

test("a member is told to ask their admin, in their own words", async ({ page }) => {
  await ensureKey(page);
  const db = admin();
  const { data: owner } = await db.from("profiles").select("family_id").eq("is_app_owner", true).single();
  const email = uniqueEmail("concierge");
  const password = "concierge-password-123";
  const { data, error } = await db.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  await db.from("profiles").insert({ id: data.user.id, family_id: owner!.family_id, display_name: "Mina" }).throwOnError();

  const errors = watchErrors(page);
  await signInWithPassword(page, email, password);
  await expect(page.getByRole("heading", { name: "Hi, Mina." })).toBeVisible();
  // Members have no Family page, so the first idea is theirs.
  const panel = await openFromMenu(page);
  await expect(panel.getByRole("button", { name: "How do I get a new model added?" })).toBeVisible();
  await panel.getByLabel("Ask Concierge").fill("how do I add a Grok key?");
  await panel.getByRole("button", { name: "Ask", exact: true }).click();
  const answer = panel.locator("[data-part=concierge-answer]");
  await expect(answer).toContainText("As a member");
  await expect(answer).toContainText("ask them to add it");
  await expect(panel.getByText("how do I add a Grok key?", { exact: true })).toBeVisible();
  // Tapping outside closes it.
  await page.mouse.click(5, 5);
  await expect(panel).toBeHidden();

  // On settings pages the bell at the top opens it, phones included.
  await page.goto("/memory");
  await page.getByRole("button", { name: "Ask Concierge" }).click();
  await expect(page.getByRole("dialog", { name: "Concierge" }).getByText("how do I add a Grok key?", { exact: true })).toBeVisible();
  await noSidewaysScroll(page);
  expect(errors).toEqual([]);
});
